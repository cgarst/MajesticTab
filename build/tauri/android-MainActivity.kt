package net.zathu.majestictab

import android.content.Context
import android.net.wifi.WifiManager
import android.os.Bundle
import android.util.Base64
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  companion object {
    @Volatile
    var instance: MainActivity? = null
      private set
  }

  private var container: FrameLayout? = null
  private var mainWebView: WebView? = null
  private var webViewsConfigured = 0
  private var multicastLock: WifiManager.MulticastLock? = null
  private var pendingOpenUrl: String? = null
  private var pendingOpenMpakFile: java.io.File? = null
  private var pendingOpenMpakName: String? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    instance = this
    WebView.setWebContentsDebuggingEnabled(
      (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
    )
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    onBackPressedDispatcher.addCallback(this, object : androidx.activity.OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val wv = mainWebView
        if (wv == null) {
          isEnabled = false
          onBackPressedDispatcher.onBackPressed()
          isEnabled = true
          return
        }
        wv.evaluateJavascript("Boolean(window.__majesticAppBack && window.__majesticAppBack())") { result ->
          if (result != "true") {
            runOnUiThread {
              isEnabled = false
              onBackPressedDispatcher.onBackPressed()
              isEnabled = true
            }
          }
        }
      }
    })
    val root = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
    handleIncomingIntent(intent)
  }

  override fun onNewIntent(intent: android.content.Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    handleIncomingIntent(intent)
  }

  private fun queryUriDisplayName(uri: android.net.Uri): String {
    if (uri.scheme == "content") {
      try {
        contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
          if (c.moveToFirst()) {
            val idx = c.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
            if (idx >= 0) {
              val n = c.getString(idx)
              if (!n.isNullOrBlank()) return n
            }
          }
        }
      } catch (_: Exception) {}
    }
    return uri.lastPathSegment?.substringAfterLast('/') ?: "song.mpak"
  }

  private fun handleIncomingIntent(intent: android.content.Intent?) {
    if (intent?.action != android.content.Intent.ACTION_VIEW) return
    val uri = intent.data ?: return
    if (uri.scheme == "majestictab") {
      val urlStr = uri.toString()
      pendingOpenUrl = urlStr
      runOnUiThread {
        mainWebView?.evaluateJavascript(
          "window.__onAppOpenUrl && window.__onAppOpenUrl(" + org.json.JSONObject.quote(urlStr) + ");",
          null
        )
      }
      return
    }
    if (uri.scheme == "content" || uri.scheme == "file") {
      Thread {
        try {
          val rawName = queryUriDisplayName(uri)
          val dest = java.io.File(cacheDir, "opened-intent.mpak")
          contentResolver.openInputStream(uri)?.use { input ->
            dest.outputStream().use { output -> input.copyTo(output) }
          } ?: return@Thread
          if (!dest.isFile || dest.length() < 8) return@Thread
          val head = ByteArray(64)
          val n = dest.inputStream().use { it.read(head) }
          val headStr = String(head, 0, maxOf(0, n), Charsets.ISO_8859_1)
          val isMpak = looksLikeMpak(headStr) || intent.type == "application/vnd.mpak+zip" || rawName.endsWith(".mpak", ignoreCase = true)
          if (!isMpak) return@Thread
          val displayName = if (rawName.endsWith(".mpak", ignoreCase = true)) rawName else "$rawName.mpak"
          pendingOpenMpakFile = dest
          pendingOpenMpakName = displayName
          val meta = org.json.JSONObject()
            .put("name", displayName)
            .put("size", dest.length())
            .toString()
          runOnUiThread {
            mainWebView?.evaluateJavascript(
              "window.__onAndroidOpenMpak && window.__onAndroidOpenMpak(" + meta + ");",
              null
            )
          }
        } catch (e: Exception) {
          android.util.Log.w("MajesticTab", "Failed to read incoming file intent", e)
        }
      }.start()
    }
  }

  // Jam mode mDNS discovery and advertising need multicast packets, which Android filters by default.
  fun setJamMulticast(on: Boolean) {
    if (on) {
      if (multicastLock == null) {
        val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        multicastLock = wifi?.createMulticastLock("majestictab-jam")?.apply {
          setReferenceCounted(false)
        }
      }
      multicastLock?.acquire()
    } else {
      multicastLock?.let { if (it.isHeld) it.release() }
    }
  }

  override fun onDestroy() {
    setJamMulticast(false)
    if (instance == this) {
      instance = null
    }
    super.onDestroy()
  }

  override fun setContentView(view: View?) {
    if (view == null) {
      super.setContentView(view)
      return
    }

    if (container == null) {
      container = FrameLayout(this)
      super.setContentView(container)
    }

    if (mainWebView == null) {
      mainWebView = view as? WebView
      container?.addView(view, FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT,
        FrameLayout.LayoutParams.MATCH_PARENT
      ))
    }
  }

  private fun reportUpdate(state: String, percent: Int) {
    runOnUiThread {
      mainWebView?.evaluateJavascript(
        "window.__onAndroidUpdate && window.__onAndroidUpdate(" +
          org.json.JSONObject.quote(state) + ", " + percent + ");",
        null
      )
    }
  }

  // The WebView's requestFullscreen only covers video; the app's immersive mode is toggled natively.
  override fun onWebViewCreate(webView: WebView) {
    // Only the app's own webview is configured; it must not pinch zoom.
    if (webViewsConfigured++ != 0) return
    webView.settings.apply {
      useWideViewPort = true
      loadWithOverviewMode = true
      setSupportZoom(false)
      builtInZoomControls = false
      displayZoomControls = false
    }
    webView.addJavascriptInterface(object {
      @JavascriptInterface
      fun setImmersive(on: Boolean) {
        runOnUiThread {
          val controller = WindowInsetsControllerCompat(window, window.decorView)
          controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
          if (on) controller.hide(WindowInsetsCompat.Type.systemBars())
          else controller.show(WindowInsetsCompat.Type.systemBars())
        }
      }

      // Paints the window behind the transparent system bars with the app theme and picks icon contrast.
      @JavascriptInterface
      fun setSystemBars(color: String, lightBackground: Boolean) {
        runOnUiThread {
          try {
            window.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(android.graphics.Color.parseColor(color)))
            val controller = WindowInsetsControllerCompat(window, window.decorView)
            controller.isAppearanceLightStatusBars = lightBackground
            controller.isAppearanceLightNavigationBars = lightBackground
          } catch (e: Exception) {
            android.util.Log.w("MajesticTab", "setSystemBars failed", e)
          }
        }
      }
    }, "AndroidImmersive")

    webView.addJavascriptInterface(object {
      @JavascriptInterface
      fun takePendingUrl(): String? {
        val url = pendingOpenUrl
        pendingOpenUrl = null
        return url
      }

      @JavascriptInterface
      fun takePendingMpak(): String? {
        val file = pendingOpenMpakFile ?: return null
        val name = pendingOpenMpakName ?: return null
        pendingOpenMpakName = null
        if (!file.isFile) return null
        return org.json.JSONObject()
          .put("name", name)
          .put("size", file.length())
          .toString()
      }

      @JavascriptInterface
      fun readOpenedMpakRange(offset: Long, length: Int): String? {
        val file = pendingOpenMpakFile ?: return null
        if (!file.isFile || offset < 0 || length <= 0) return null
        return try {
          java.io.RandomAccessFile(file, "r").use { raf ->
            raf.seek(offset)
            val remaining = (file.length() - offset).coerceAtLeast(0L)
            val toRead = minOf(length.toLong(), remaining).toInt()
            if (toRead <= 0) return ""
            val buf = ByteArray(toRead)
            raf.readFully(buf)
            Base64.encodeToString(buf, Base64.NO_WRAP)
          }
        } catch (_: Exception) {
          null
        }
      }
    }, "AndroidOpen")

    // @selfUpdate:begin
    // In-app updates: download the release APK, then hand it to the system package installer.
    webView.addJavascriptInterface(object {
      @JavascriptInterface
      fun install(url: String) {
        if (!url.startsWith("https://github.com/cgarst/MajesticTab/releases/")) {
          reportUpdate("error", 0)
          return
        }
        if (!packageManager.canRequestPackageInstalls()) {
          // The user must allow installs from this app once; send them to that settings page.
          runOnUiThread {
            startActivity(
              android.content.Intent(
                android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                android.net.Uri.parse("package:$packageName")
              )
            )
          }
          reportUpdate("permission", 0)
          return
        }
        Thread {
          try {
            val dir = java.io.File(cacheDir, "updates").apply { mkdirs() }
            val apk = java.io.File(dir, "MajesticTab-update.apk")
            val connection = java.net.URL(url).openConnection() as java.net.HttpURLConnection
            connection.connectTimeout = 15000
            connection.readTimeout = 30000
            connection.instanceFollowRedirects = true
            val total = connection.contentLengthLong
            var done = 0L
            var lastPercent = -1
            connection.inputStream.use { input ->
              apk.outputStream().use { output ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                  val read = input.read(buffer)
                  if (read < 0) break
                  output.write(buffer, 0, read)
                  done += read
                  val percent = if (total > 0) (done * 100 / total).toInt() else 0
                  if (percent != lastPercent) {
                    lastPercent = percent
                    reportUpdate("downloading", percent)
                  }
                }
              }
            }
            // A cut-off download would leave the installer with a corrupt APK, so fail here with the sizes logged.
            if (total > 0 && done != total) {
              android.util.Log.e("MajesticTab", "APK download incomplete: got $done of $total bytes")
              apk.delete()
              reportUpdate("error", 0)
              return@Thread
            }
            android.util.Log.i("MajesticTab", "APK downloaded: $done bytes (expected $total), file ${apk.length()}")
            val uri = androidx.core.content.FileProvider.getUriForFile(
              this@MainActivity, "$packageName.updateprovider", apk
            )
            // ACTION_INSTALL_PACKAGE is the dedicated installer intent; a plain ACTION_VIEW can be swallowed
            // silently on some devices. Launch from the UI thread and report real failures.
            val intent = android.content.Intent(android.content.Intent.ACTION_INSTALL_PACKAGE).apply {
              setDataAndType(uri, "application/vnd.android.package-archive")
              putExtra(android.content.Intent.EXTRA_NOT_UNKNOWN_SOURCE, true)
              addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            runOnUiThread {
              try {
                startActivity(intent)
                reportUpdate("installing", 100)
              } catch (e: Exception) {
                android.util.Log.e("MajesticTab", "Could not open the package installer", e)
                reportUpdate("error", 0)
              }
            }
          } catch (e: Exception) {
            android.util.Log.e("MajesticTab", "APK update failed", e)
            reportUpdate("error", 0)
          }
        }.start()
      }
    }, "AndroidUpdater")
    // @selfUpdate:end

    // Android's share sheet: the page streams a file in pieces, then finish() hands it to the system chooser.
    // The file sits in the cache folder, which Tauri's own FileProvider already serves.
    webView.addJavascriptInterface(object {
      private var out: java.io.OutputStream? = null
      private var file: java.io.File? = null

      @JavascriptInterface
      @Synchronized
      fun begin(name: String): Boolean {
        return try {
          out?.close()
          val dir = java.io.File(cacheDir, "shared")
          dir.deleteRecursively()
          dir.mkdirs()
          val f = java.io.File(dir, name.replace(Regex("[\\\\/:*?\"<>|]"), "_").ifBlank { "song" })
          file = f
          out = java.io.FileOutputStream(f)
          true
        } catch (e: Exception) {
          android.util.Log.w("MajesticTab", "Share could not start", e)
          false
        }
      }

      @JavascriptInterface
      @Synchronized
      fun append(base64: String): Boolean {
        return try {
          out?.write(Base64.decode(base64, Base64.DEFAULT)) ?: return false
          true
        } catch (e: Exception) {
          android.util.Log.w("MajesticTab", "Share could not write", e)
          false
        }
      }

      @JavascriptInterface
      @Synchronized
      fun finish(mimeType: String, title: String): Boolean {
        val f = file ?: return false
        try { out?.close() } catch (_: Exception) {}
        out = null
        return try {
          val uri = androidx.core.content.FileProvider.getUriForFile(this@MainActivity, "$packageName.fileprovider", f)
          val send = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
            type = mimeType.ifBlank { "application/octet-stream" }
            putExtra(android.content.Intent.EXTRA_STREAM, uri)
            putExtra(android.content.Intent.EXTRA_TITLE, title)
            addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
          }
          val chooser = android.content.Intent.createChooser(send, title).apply {
            addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
          }
          runOnUiThread { startActivity(chooser) }
          true
        } catch (e: Exception) {
          android.util.Log.w("MajesticTab", "Share failed", e)
          false
        }
      }
    }, "AndroidShare")

    webView.addJavascriptInterface(object {
      @JavascriptInterface
      fun setMulticast(on: Boolean) {
        setJamMulticast(on)
      }
    }, "AndroidJam")

    // Android TV launches the same APK, so the page asks whether it is running on a television.
    webView.addJavascriptInterface(object {
      @JavascriptInterface
      fun isTelevision(): Boolean {
        val uiMode = getSystemService(Context.UI_MODE_SERVICE) as? android.app.UiModeManager
        return uiMode?.currentModeType == android.content.res.Configuration.UI_MODE_TYPE_TELEVISION
      }
    }, "AndroidTv")
  }

  // A .mpak has no magic number and no rule on entry order, so this only guesses a name from a leading manifest; the app
  // itself decides from the manifest.
  private fun looksLikeMpak(head: String): Boolean =
    head.startsWith("PK\u0003\u0004") && head.length >= 43 &&
      head.startsWith("manifest.json", 30)

  override fun dispatchKeyEvent(event: android.view.KeyEvent): Boolean {
    if (event.action == android.view.KeyEvent.ACTION_DOWN) {
      val keyName = when (event.keyCode) {
        android.view.KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> "MediaPlayPause"
        android.view.KeyEvent.KEYCODE_MEDIA_PLAY -> "MediaPlay"
        android.view.KeyEvent.KEYCODE_MEDIA_PAUSE -> "MediaPause"
        android.view.KeyEvent.KEYCODE_MENU -> "ContextMenu"
        else -> null
      }
      if (keyName != null && mainWebView != null) {
        val js = "window.dispatchEvent(new KeyboardEvent('keydown',{key:" +
          org.json.JSONObject.quote(keyName) + ",bubbles:true,cancelable:true}));"
        mainWebView?.evaluateJavascript(js, null)
        return true
      }
    }
    return super.dispatchKeyEvent(event)
  }
}
