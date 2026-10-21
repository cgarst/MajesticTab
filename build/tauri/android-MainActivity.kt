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
      ))
      downloaderWebView?.visibility = View.VISIBLE
    }
  }

  fun hideDownloader() {
    runOnUiThread {
      downloaderWebView?.visibility = View.GONE
      mainWebView?.visibility = View.VISIBLE
      mainWebView?.requestFocus()
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
    webView.settings.apply {
      useWideViewPort = true
      loadWithOverviewMode = true
      builtInZoomControls = true
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

      @JavascriptInterface
      fun saveSources(sourcesJson: String) {
        android.util.Log.i("MajesticTab", "saveSources received: " + sourcesJson.length + " chars")
        runOnUiThread {
          val script = "window.__onSaveSources && window.__onSaveSources(" +
            org.json.JSONObject.quote(sourcesJson) + ");"
          mainWebView?.evaluateJavascript(script, null)
        }
      }
    }, "MajesticDownloaderNative")
  }
}
