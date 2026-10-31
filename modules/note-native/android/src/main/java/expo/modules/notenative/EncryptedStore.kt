package expo.modules.notenative

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.io.OutputStream
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URL
import java.security.KeyStore
import java.security.SecureRandom
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlin.concurrent.thread

/**
 * Phase 2: encrypted offline storage.
 *
 * Saved songs are never written to disk as playable audio. Each one is
 * streamed through an AES-256-GCM chunk encryptor as it downloads, so the
 * only bytes at rest are ciphertext. The key is generated once and held in
 * the Android Keystore as non-exportable: it never leaves the Keystore,
 * is never handed to JavaScript, and is never written anywhere else.
 *
 * File format (all integers big-endian):
 *
 *   header  17 bytes: magic "ESEI" | version u8 | chunkSize u32 | plainLength u64
 *   chunk i  nonce 12 bytes | ciphertext (chunkPlain + 16-byte GCM tag)
 *
 * Every chunk except the last holds exactly chunkSize plaintext bytes, so a
 * plaintext offset maps to a file offset arithmetically -- playback can
 * decrypt only the chunks a byte range actually touches.
 *
 * Playback goes through a loopback server (127.0.0.1, ephemeral port, random
 * per-process token in the path) that decrypts on the fly and honours HTTP
 * Range requests. Nothing off-device can reach it, and nothing in the app
 * can use it without the token. The audio the player decodes exists only in
 * memory; no plain file is ever materialised.
 */
class EncryptedStore private constructor(context: Context) {

  companion object {
    @Volatile
    private var instance: EncryptedStore? = null

    fun get(context: Context): EncryptedStore =
      instance ?: synchronized(this) {
        instance ?: EncryptedStore(context.applicationContext).also { instance = it }
      }

    private const val KEY_ALIAS = "esei_offline_key_v1"
    private const val DIR_NAME = "esei-downloads"
    private const val FORMAT_VERSION = 1
    private const val CHUNK_SIZE = 256 * 1024
    private const val HEADER_SIZE = 17
    private const val NONCE_SIZE = 12
    private const val TAG_BITS = 128
    private const val TAG_BYTES = TAG_BITS / 8
    private const val CONNECT_TIMEOUT_MS = 30_000
    private const val READ_TIMEOUT_MS = 30_000
    private val MAGIC = byteArrayOf('E'.code.toByte(), 'S'.code.toByte(), 'E'.code.toByte(), 'I'.code.toByte())
  }

  private val dir: File = File(context.filesDir, DIR_NAME)
  private val random = SecureRandom()

  // ---- key management -----------------------------------------------------

  /** The offline key, created on first use. Never leaves the Keystore. */
  @Synchronized
  private fun key(): SecretKey {
    val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (keyStore.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let {
      return it.secretKey
    }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    generator.init(
      KeyGenParameterSpec.Builder(
        KEY_ALIAS,
        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
      )
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build()
    )
    return generator.generateKey()
  }

  // ---- file naming ----------------------------------------------------------

  private fun safeBase(sourceId: String): String =
    sourceId.replace(Regex("[^a-zA-Z0-9_-]"), "_")

  private fun fileFor(sourceId: String): File = File(dir, "${safeBase(sourceId)}.esei")
  private fun tempFor(sourceId: String): File = File(dir, "${safeBase(sourceId)}.esei.part")

  fun fileInfo(sourceId: String): Pair<Boolean, Long> {
    val f = fileFor(sourceId)
    return if (f.exists()) true to f.length() else false to 0L
  }

  // ---- download + encrypt ---------------------------------------------------

  /**
   * Stream [url] and write it encrypted to the final file. Bytes flow
   * network -> encrypt -> disk; a plain copy never exists. The write goes
   * to a `.part` sibling and is renamed only after the header's length
   * field has been patched, so an interrupted download can never be
   * mistaken for a complete one.
   *
   * Returns the absolute path, encrypted size and plaintext size.
   */
  fun downloadAndEncrypt(
    url: String,
    headers: Map<String, String>,
    sourceId: String
  ): Triple<String, Long, Long> {
    if (!dir.exists()) dir.mkdirs()

    val temp = tempFor(sourceId)
    val final = fileFor(sourceId)
    if (temp.exists()) temp.delete()

    val connection = (URL(url).openConnection() as HttpURLConnection).apply {
      requestMethod = "GET"
      connectTimeout = CONNECT_TIMEOUT_MS
      readTimeout = READ_TIMEOUT_MS
      instanceFollowRedirects = true
      headers.forEach { (name, value) -> setRequestProperty(name, value) }
    }

    var plainTotal = 0L
    try {
      val code = connection.responseCode
      if (code !in 200..299) {
        throw IOException("HTTP $code while downloading")
      }

      BufferedOutputStream(FileOutputStream(temp)).use { out ->
        // Header with a placeholder length; patched once the total is known.
        out.write(MAGIC)
        out.write(FORMAT_VERSION)
        out.writeInt32(CHUNK_SIZE)
        out.writeInt64(0L)

        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        val key = key()
        val plain = ByteArray(CHUNK_SIZE)

        BufferedInputStream(connection.inputStream).use { input ->
          while (true) {
            // Fill a whole chunk (or hit EOF) so chunk boundaries stay
            // aligned with the file format's assumption.
            var filled = 0
            while (filled < CHUNK_SIZE) {
              val n = input.read(plain, filled, CHUNK_SIZE - filled)
              if (n < 0) break
              filled += n
            }
            if (filled == 0) break

            val nonce = ByteArray(NONCE_SIZE).also { random.nextBytes(it) }
            cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(TAG_BITS, nonce))
            val ciphertext = cipher.doFinal(plain, 0, filled)
            out.write(nonce)
            out.write(ciphertext)
            plainTotal += filled
          }
        }
      }

      if (plainTotal <= 0L) throw IOException("Empty response body")

      // Patch the real plaintext length into the header.
      RandomAccessFile(temp, "rw").use { raf ->
        raf.seek((MAGIC.size + 1 + 4).toLong())
        raf.writeLong(plainTotal)
      }

      if (final.exists()) final.delete()
      if (!temp.renameTo(final)) {
        throw IOException("Could not finalise encrypted file")
      }
      return Triple(final.absolutePath, final.length(), plainTotal)
    } catch (e: Throwable) {
      temp.delete()
      throw e
    } finally {
      connection.disconnect()
    }
  }

  fun delete(sourceId: String): Boolean {
    registry.remove(safeBase(sourceId))
    val f = fileFor(sourceId)
    tempFor(sourceId).delete()
    return if (f.exists()) f.delete() else true
  }

  // ---- decryption -------------------------------------------------------------

  private class Header(val chunkSize: Int, val plainLength: Long)

  private fun readHeader(raf: RandomAccessFile): Header {
    raf.seek(0)
    val magic = ByteArray(4)
    raf.readFully(magic)
    if (!magic.contentEquals(MAGIC)) throw IOException("Not an Esei encrypted file")
    val version = raf.read()
    if (version != FORMAT_VERSION) throw IOException("Unsupported format version $version")
    val chunkSize = raf.readInt()
    val plainLength = raf.readLong()
    if (chunkSize <= 0 || plainLength < 0) throw IOException("Corrupt header")
    return Header(chunkSize, plainLength)
  }

  /** File offset of chunk [index]'s record (nonce + ciphertext). */
  private fun chunkOffset(header: Header, index: Long): Long =
    HEADER_SIZE + index * (NONCE_SIZE + header.chunkSize + TAG_BYTES)

  private fun decryptChunk(raf: RandomAccessFile, header: Header, index: Long): ByteArray {
    val chunkStart = index * header.chunkSize
    val chunkPlain = minOf(header.chunkSize.toLong(), header.plainLength - chunkStart).toInt()
    raf.seek(chunkOffset(header, index))
    val nonce = ByteArray(NONCE_SIZE)
    raf.readFully(nonce)
    val ciphertext = ByteArray(chunkPlain + TAG_BYTES)
    raf.readFully(ciphertext)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, nonce))
    return cipher.doFinal(ciphertext)
  }

  // ---- loopback playback server ----------------------------------------------

  private data class Entry(val file: File, val mimeType: String)

  private val registry = ConcurrentHashMap<String, Entry>()

  @Volatile
  private var serverSocket: ServerSocket? = null

  @Volatile
  private var serverToken: String = ""

  @Volatile
  private var serverPort: Int = 0

  /**
   * Register a saved song with the playback server (starting it on first
   * use) and return the URL the player should load. Null when the file is
   * not on disk.
   */
  @Synchronized
  fun playbackUrl(sourceId: String, mimeType: String?): String? {
    val file = fileFor(sourceId)
    if (!file.exists()) return null
    val id = safeBase(sourceId)
    registry[id] = Entry(file, mimeType?.takeIf { it.isNotBlank() } ?: "audio/mp4")
    ensureServer()
    return "http://127.0.0.1:$serverPort/$serverToken/media/$id"
  }

  private fun ensureServer() {
    if (serverSocket != null) return
    val socket = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
    serverSocket = socket
    serverPort = socket.localPort
    serverToken = UUID.randomUUID().toString()
    thread(isDaemon = true, name = "esei-offline-server") {
      while (!socket.isClosed) {
        try {
          val client = socket.accept()
          thread(isDaemon = true) { handle(client) }
        } catch (_: Throwable) {
          // A failed accept must not kill the server; if the socket closed
          // the loop condition ends the thread.
          if (socket.isClosed) break
        }
      }
    }
  }

  private fun handle(client: Socket) {
    try {
      client.soTimeout = 30_000
      val reader = client.getInputStream().bufferedReader(Charsets.ISO_8859_1)
      val requestLine = reader.readLine() ?: run { client.close(); return }
      val parts = requestLine.split(' ')
      if (parts.size < 2) {
        client.close()
        return
      }
      val method = parts[0]
      val path = parts[1]

      var rangeHeader: String? = null
      while (true) {
        val line = reader.readLine() ?: break
        if (line.isEmpty()) break
        val colon = line.indexOf(':')
        if (colon > 0 && line.substring(0, colon).trim().equals("Range", ignoreCase = true)) {
          rangeHeader = line.substring(colon + 1).trim()
        }
      }

      val segments = path.split('/').filter { it.isNotEmpty() }
      if (segments.size != 3 || segments[0] != serverToken || segments[1] != "media") {
        writeResponse(client, 403, "Forbidden", null, 0, null)
        return
      }
      val entry = registry[segments[2]]
      if (entry == null || !entry.file.exists()) {
        writeResponse(client, 404, "Not Found", null, 0, null)
        return
      }
      if (method != "GET" && method != "HEAD") {
        writeResponse(client, 405, "Method Not Allowed", null, 0, null)
        return
      }

      RandomAccessFile(entry.file, "r").use { raf ->
        val header = readHeader(raf)
        val total = header.plainLength

        var start = 0L
        var end = total - 1
        var partial = false

        val range = parseRange(rangeHeader, total)
        if (range == UNSATISFIABLE) {
          writeResponse(
            client, 416, "Range Not Satisfiable", entry.mimeType, 0,
            "bytes */$total"
          )
          return
        }
        if (range != null) {
          start = range.first
          end = range.second
          partial = true
        }

        val length = if (total == 0L) 0L else end - start + 1
        writeResponse(
          client,
          if (partial) 206 else 200,
          if (partial) "Partial Content" else "OK",
          entry.mimeType,
          length,
          if (partial) "bytes $start-$end/$total" else null
        )
        if (method == "HEAD" || length == 0L) return

        val out = BufferedOutputStream(client.getOutputStream(), 64 * 1024)
        var position = start
        var remaining = length
        var chunkIndex = position / header.chunkSize
        while (remaining > 0) {
          val plain = decryptChunk(raf, header, chunkIndex)
          val from = (position - chunkIndex * header.chunkSize).toInt()
          val n = minOf((plain.size - from).toLong(), remaining).toInt()
          out.write(plain, from, n)
          position += n
          remaining -= n
          chunkIndex++
        }
        out.flush()
      }
    } catch (_: Throwable) {
      // A broken pipe (player moved on) or a corrupt file must never take
      // down the server thread beyond this one connection.
    } finally {
      try {
        client.close()
      } catch (_: Throwable) {
      }
    }
  }

  private val UNSATISFIABLE = -1L to -1L

  /**
   * Parse a single-range `Range` header against [total]. Returns null to
   * serve the whole body (absent/unsupported/multi-range), UNSATISFIABLE
   * for a 416, or the inclusive [start, end] pair.
   */
  private fun parseRange(header: String?, total: Long): Pair<Long, Long>? {
    if (header == null || total == 0L) return null
    if (!header.startsWith("bytes=")) return null
    val spec = header.substring("bytes=".length).trim()
    if (spec.contains(',')) return null // multi-range: fall back to full body
    val dash = spec.indexOf('-')
    if (dash < 0) return null
    val startText = spec.substring(0, dash).trim()
    val endText = spec.substring(dash + 1).trim()

    return try {
      if (startText.isEmpty()) {
        // Suffix range: the last N bytes.
        val suffix = endText.toLong()
        if (suffix <= 0) UNSATISFIABLE else (maxOf(0L, total - suffix) to total - 1)
      } else {
        val start = startText.toLong()
        if (start >= total) return UNSATISFIABLE
        val end = if (endText.isEmpty()) total - 1 else minOf(endText.toLong(), total - 1)
        if (end < start) UNSATISFIABLE else (start to end)
      }
    } catch (_: NumberFormatException) {
      null
    }
  }

  private fun writeResponse(
    client: Socket,
    code: Int,
    reason: String,
    contentType: String?,
    contentLength: Long,
    contentRange: String?
  ) {
    val out = client.getOutputStream()
    val sb = StringBuilder()
    sb.append("HTTP/1.1 ").append(code).append(' ').append(reason).append("\r\n")
    if (contentType != null) sb.append("Content-Type: ").append(contentType).append("\r\n")
    sb.append("Content-Length: ").append(contentLength).append("\r\n")
    sb.append("Accept-Ranges: bytes\r\n")
    if (contentRange != null) sb.append("Content-Range: ").append(contentRange).append("\r\n")
    sb.append("Connection: close\r\n\r\n")
    out.write(sb.toString().toByteArray(Charsets.ISO_8859_1))
    out.flush()
  }

  // ---- small binary helpers ---------------------------------------------------

  private fun OutputStream.writeInt32(v: Int) {
    write(v ushr 24)
    write(v ushr 16)
    write(v ushr 8)
    write(v)
  }

  private fun OutputStream.writeInt64(v: Long) {
    writeInt32((v ushr 32).toInt())
    writeInt32(v.toInt())
  }
}
