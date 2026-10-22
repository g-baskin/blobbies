package com.blobbies.app

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@InvokeArg
class SecretNameArgs {
  lateinit var name: String
}

@InvokeArg
class SecretSetArgs {
  lateinit var name: String
  lateinit var value: String
}

/**
 * Native side of the `blobbies-android` plugin (see src-tauri/src/android_bridge.rs).
 *
 * Secrets: AES-256-GCM with a non-exportable key in the Android Keystore; the
 * IV and ciphertext (base64) live in private SharedPreferences. The name
 * allowlist is enforced in Rust and again here (ALLOWED_NAMES). Values are never logged.
 *
 * Shares: ACTION_SEND / ACTION_SEND_MULTIPLE intents are parsed into a single
 * pending share, taken once by `takePendingShare`; shares arriving while the
 * app runs also fire the `share` event.
 */
@TauriPlugin
class BlobbiesPlugin(private val activity: Activity) : Plugin(activity) {
  private val prefs by lazy {
    activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
  }

  @Volatile private var pendingShare: JSObject? = null
  // Raw `blobbies://pair#...` URI. Contains the sync key: never log it.
  @Volatile private var pendingPairLink: String? = null

  override fun load(webView: WebView) {
    super.load(webView)
    pendingShare = readShare(activity.intent)
    pendingPairLink = readPairLink(activity.intent)
    // Mark the launch intent consumed so a recreated activity doesn't replay it.
    if (pendingShare != null || pendingPairLink != null) activity.intent = Intent(Intent.ACTION_MAIN)
  }

  override fun onNewIntent(intent: Intent) {
    readPairLink(intent)?.let { url ->
      pendingPairLink = url
      trigger("pairLink", JSObject().put("url", url))
      return
    }
    val share = readShare(intent) ?: return
    pendingShare = share
    trigger("share", share)
  }

  // ---- Secrets ----

  @Command
  fun secretGet(invoke: Invoke) {
    val args = invoke.parseArgs(SecretNameArgs::class.java)
    if (args.name !in ALLOWED_NAMES) {
      invoke.reject("secret name not allowed")
      return
    }
    try {
      val stored = prefs.getString(prefKey(args.name), null)
      val result = JSObject()
      if (stored == null) {
        result.put("value", JSONObject.NULL)
      } else {
        result.put("value", decrypt(stored))
      }
      invoke.resolve(result)
    } catch (e: Exception) {
      invoke.reject("secure storage read failed")
    }
  }

  @Command
  fun secretSet(invoke: Invoke) {
    val args = invoke.parseArgs(SecretSetArgs::class.java)
    if (args.name !in ALLOWED_NAMES) {
      invoke.reject("secret name not allowed")
      return
    }
    try {
      val ok = prefs.edit().putString(prefKey(args.name), encrypt(args.value)).commit()
      if (ok) invoke.resolve() else invoke.reject("secure storage write failed")
    } catch (e: Exception) {
      invoke.reject("secure storage write failed")
    }
  }

  @Command
  fun secretDelete(invoke: Invoke) {
    val args = invoke.parseArgs(SecretNameArgs::class.java)
    if (args.name !in ALLOWED_NAMES) {
      invoke.reject("secret name not allowed")
      return
    }
    prefs.edit().remove(prefKey(args.name)).commit()
    invoke.resolve()
  }

  private fun prefKey(name: String) = "secret:$name"

  private fun key(): SecretKey {
    val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
    (store.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
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

  /** "base64(iv):base64(ciphertext+tag)" */
  private fun encrypt(plain: String): String {
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, key())
    val ct = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
    return b64(cipher.iv) + ":" + b64(ct)
  }

  private fun decrypt(stored: String): String {
    val parts = stored.split(":", limit = 2)
    require(parts.size == 2)
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(
      Cipher.DECRYPT_MODE,
      key(),
      GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP))
    )
    return String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), Charsets.UTF_8)
  }

  private fun b64(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.NO_WRAP)

  // ---- Pair link ----

  @Command
  fun takePendingPairLink(invoke: Invoke) {
    val url = pendingPairLink
    pendingPairLink = null
    invoke.resolve(JSObject().put("url", url ?: JSONObject.NULL))
  }

  /** The raw `blobbies://pair...` string, or null. Never logged. */
  private fun readPairLink(intent: Intent?): String? {
    if (intent == null || intent.action != Intent.ACTION_VIEW) return null
    val raw = intent.dataString ?: return null
    if (raw.length > MAX_PAIR_LINK_CHARS) return null
    val uri = intent.data ?: return null
    if (uri.scheme != "blobbies" || uri.host != "pair") return null
    return raw
  }

  // ---- Share sheet ----

  @Command
  fun takePendingShare(invoke: Invoke) {
    val share = pendingShare
    pendingShare = null
    if (share == null) {
      // Wrapped so JS sees `{share: null}`.
      invoke.resolve(JSObject().put("share", JSONObject.NULL))
    } else {
      invoke.resolve(JSObject().put("share", share))
    }
  }

  private fun readShare(intent: Intent?): JSObject? {
    if (intent == null) return null
    val action = intent.action
    if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return null

    val uris = mutableListOf<Uri>()
    if (action == Intent.ACTION_SEND) {
      streamExtra(intent)?.let { uris.add(it) }
    } else {
      streamListExtra(intent)?.let { uris.addAll(it) }
    }

    val files = JSArray()
    var budget = MAX_TOTAL_BYTES
    for (uri in uris.take(MAX_FILES)) {
      readFile(uri, intent.type, budget)?.let { (obj, size) ->
        files.put(obj)
        budget -= size
      }
    }
    val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString() ?: ""
    val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT) ?: ""
    if (text.isEmpty() && files.length() == 0) return null

    val share = JSObject()
    share.put("text", text)
    share.put("subject", subject)
    share.put("files", files)
    return share
  }

  @Suppress("DEPRECATION")
  private fun streamExtra(intent: Intent): Uri? =
    if (Build.VERSION.SDK_INT >= 33) {
      intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
    } else {
      intent.getParcelableExtra(Intent.EXTRA_STREAM) as? Uri
    }

  @Suppress("DEPRECATION")
  private fun streamListExtra(intent: Intent): List<Uri>? =
    if (Build.VERSION.SDK_INT >= 33) {
      intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
    } else {
      intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)
    }

  /** Reads one shared file, or null if unreadable or over MAX_FILE_BYTES. */
  private fun readFile(uri: Uri, fallbackType: String?, budget: Long): Pair<JSObject, Long>? {
    // content:// only, and never our own provider: a file:// or
    // our own FileProvider URI could point at app-private data
    // (e.g. the secrets prefs) and exfiltrate it through the chat.
    if (uri.scheme != "content") return null
    if (uri.authority?.startsWith(activity.packageName) == true) return null
    val limit = minOf(MAX_FILE_BYTES, budget)
    if (limit <= 0) return null
    return try {
      val resolver = activity.contentResolver
      var name = uri.lastPathSegment ?: "shared"
      resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
        if (c.moveToFirst()) {
          val idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          if (idx >= 0) c.getString(idx)?.let { name = it }
        }
      }
      val mime = resolver.getType(uri) ?: fallbackType ?: "application/octet-stream"
      val bytes = resolver.openInputStream(uri)?.use { input ->
        val out = ByteArrayOutputStream()
        val buf = ByteArray(64 * 1024)
        var total = 0L
        while (true) {
          val n = input.read(buf)
          if (n < 0) break
          total += n
          if (total > limit) return null
          out.write(buf, 0, n)
        }
        out.toByteArray()
      } ?: return null
      JSObject().apply {
        put("name", name)
        put("mimeType", mime)
        put("base64", b64(bytes))
      } to bytes.size.toLong()
    } catch (e: Exception) {
      null
    }
  }

  companion object {
    private const val PREFS = "blobbies_secrets"
    private const val KEYSTORE = "AndroidKeyStore"
    private const val KEY_ALIAS = "blobbies_secrets_key"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    private const val MAX_FILES = 10
    private const val MAX_FILE_BYTES = 20L * 1024 * 1024
    private const val MAX_TOTAL_BYTES = 40L * 1024 * 1024
    // Mirrors ALLOWED_NAMES in src-tauri/src/secrets.rs: defence in depth in
    // case JS reaches this plugin directly via plugin:blobbies-android|...
    private val ALLOWED_NAMES = setOf(
      "tinfoil-api-key",
      "tinfoil-cache-secret",
      "composio-oauth",
      "composio-api-key",
      "sync-key",
      "sync-remote"
    )
    private const val MAX_PAIR_LINK_CHARS = 4 * 1024
  }
}
