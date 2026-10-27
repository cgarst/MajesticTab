package net.zathu.majestictab

import android.content.Context
import android.net.wifi.WifiManager
import android.os.Bundle
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
  private var downloaderWebView: WebView? = null
  // Height of the main webview's tab downloader bar in device pixels; the downloader webview sits below it.
  private var downloaderTopInsetPx = 0
  private var webViewsConfigured = 0
  private var multicastLock: WifiManager.MulticastLock? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    instance = this
    WebView.setWebContentsDebuggingEnabled(true)
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    val root = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
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
    } else {
      downloaderWebView?.let { container?.removeView(it) }
      downloaderWebView = view as? WebView
      container?.addView(view, FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT,
        FrameLayout.LayoutParams.MATCH_PARENT
      ).apply { topMargin = downloaderTopInsetPx })
      downloaderWebView?.visibility = View.VISIBLE
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

  fun hideDownloader() {
    runOnUiThread {
      downloaderWebView?.visibility = View.GONE
      mainWebView?.visibility = View.VISIBLE
      mainWebView?.requestFocus()
    }
  }

  fun setDownloaderTopInset(px: Int) {
    runOnUiThread {
      downloaderTopInsetPx = px.coerceAtLeast(0)
      downloaderWebView?.let { view ->
        (view.layoutParams as? FrameLayout.LayoutParams)?.let { params ->
          params.topMargin = downloaderTopInsetPx
          view.layoutParams = params
        }
      }
    }
  }

  fun showDownloader() {
    runOnUiThread {
      downloaderWebView?.visibility = View.VISIBLE
      downloaderWebView?.requestFocus()
    }
  }

  // The WebView's requestFullscreen only covers video; the app's immersive mode is toggled natively.
  override fun onWebViewCreate(webView: WebView) {
    // The first webview is the app itself, which must not pinch zoom: that would scale the downloader bar.
    // Only the downloader webview (created later) zooms, and only inside its own bounds.
    val isAppWebView = webViewsConfigured++ == 0
    webView.settings.apply {
      useWideViewPort = true
      loadWithOverviewMode = true
      setSupportZoom(!isAppWebView)
      builtInZoomControls = !isAppWebView
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

      @JavascriptInterface
      fun closeDownloader() {
        hideDownloader()
      }
    }, "AndroidImmersive")

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
            val uri = androidx.core.content.FileProvider.getUriForFile(
              this@MainActivity, "$packageName.updateprovider", apk
            )
            val intent = android.content.Intent(android.content.Intent.ACTION_VIEW).apply {
              setDataAndType(uri, "application/vnd.android.package-archive")
              addFlags(
                android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION or
                  android.content.Intent.FLAG_ACTIVITY_NEW_TASK
              )
            }
            runOnUiThread { startActivity(intent) }
            reportUpdate("installing", 100)
          } catch (e: Exception) {
            android.util.Log.e("MajesticTab", "APK update failed", e)
            reportUpdate("error", 0)
          }
        }.start()
      }
    }, "AndroidUpdater")

    webView.addJavascriptInterface(object {
      @JavascriptInterface
      fun setMulticast(on: Boolean) {
        setJamMulticast(on)
      }
    }, "AndroidJam")

    webView.addJavascriptInterface(object {
      @JavascriptInterface
      fun close() {
        hideDownloader()
      }

      @JavascriptInterface
      fun show() {
        showDownloader()
      }

      @JavascriptInterface
      fun setTopInsetPx(px: Int) {
        setDownloaderTopInset(px)
      }

      // Native views draw above HTML, so the app hides the downloader while its settings modal is open.
      @JavascriptInterface
      fun setVisible(on: Boolean) {
        if (on) showDownloader() else runOnUiThread { downloaderWebView?.visibility = View.GONE }
      }

      @JavascriptInterface
      fun onTabDownloaded(name: String, base64Data: String) {
        android.util.Log.i("MajesticTab", "onTabDownloaded received: " + name + " (" + base64Data.length + " chars)")
        runOnUiThread {
          hideDownloader()
          val script = "window.__onTabDownloaded && window.__onTabDownloaded(" +
            org.json.JSONObject.quote(name) + ", " +
            org.json.JSONObject.quote(base64Data) + ");"
          mainWebView?.evaluateJavascript(script, null)
        }
      }
    }, "MajesticDownloaderNative")
  }
}
