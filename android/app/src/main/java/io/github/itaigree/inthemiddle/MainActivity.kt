package io.github.itaigree.inthemiddle

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Bitmap
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.webkit.GeolocationPermissions
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.google.android.gms.ads.AdRequest
import com.google.android.gms.ads.AdSize
import com.google.android.gms.ads.AdView
import com.google.android.gms.ads.MobileAds
import com.google.android.ump.ConsentRequestParameters
import com.google.android.ump.UserMessagingPlatform
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The app is the site itself (loaded from its address, so it is always the
 * current version), with an AdMob banner under it.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var web: WebView
    private lateinit var adBox: FrameLayout
    private lateinit var offline: View
    private var adView: AdView? = null
    private var bannerWidthDp = 0
    private val adsStarted = AtomicBoolean(false)

    // The page failed to load (no network before the site could work offline).
    private var loadFailed = false
    private var networkCallbackRegistered = false

    // Back online while the offline message shows: try again by itself.
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            runOnUiThread { if (!isDestroyed && offline.visibility == View.VISIBLE) retry() }
        }
    }

    // "My location" on the site waits for Android's permission.
    private var pendingGeo: Pair<String, GeolocationPermissions.Callback>? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        web = findViewById(R.id.web)
        adBox = findViewById(R.id.ad)
        offline = findViewById(R.id.offline)
        findViewById<View>(R.id.retry).setOnClickListener { retry() }

        // Android 15 draws apps under the status and navigation bars: keep clear of them.
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(R.id.root)) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true // the site keeps settings and caches there
            setGeolocationEnabled(true)
            // So the site can tell it runs in the app.
            userAgentString = "$userAgentString InTheMiddleApp/${BuildConfig.VERSION_NAME}"
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (!request.isForMainFrame) return false
                val url = request.url
                // The site itself stays in the app; everything else (Waze, Google Maps,
                // photo credits…) opens in its own app or the browser.
                if (url.scheme == "https" && url.host == SITE.host && (url.path ?: "").startsWith(SITE.path ?: "/")) return false
                openOutside(url)
                return true
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                loadFailed = false
            }

            // Before the site has been saved for offline use (the first launch), no
            // network leaves WebView's own error page, with no way to try again.
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (!request.isForMainFrame) return
                loadFailed = true
                offline.visibility = View.VISIBLE
            }

            override fun onPageFinished(view: WebView, url: String?) {
                if (loadFailed || offline.visibility != View.VISIBLE) return
                offline.visibility = View.GONE
                // Consent and the banner need the network too: after an offline first
                // launch they never started.
                if (!adsStarted.get()) startAds()
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
                if (hasLocationPermission()) {
                    callback.invoke(origin, true, false)
                } else {
                    pendingGeo = origin to callback
                    ActivityCompat.requestPermissions(
                        this@MainActivity,
                        arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION),
                        LOCATION_REQUEST,
                    )
                }
            }
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) {
                    web.goBack()
                } else {
                    // Let the system have this press. Since Android 12 it only sends the
                    // app to the background, and the same activity comes back later:
                    // take Back again then, or it would never go back in the site.
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                    isEnabled = true
                }
            }
        })

        // The banner is as wide as the screen: rotating, folding or resizing the window
        // changes that without recreating the activity (configChanges), so size it again
        // (loadBanner does nothing while the width in dp is the same).
        adBox.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ ->
            if (adsStarted.get()) adBox.post { loadBanner() }
        }

        // Only for retrying by itself; some devices refuse it, and the retry button still works.
        try {
            getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(networkCallback)
            networkCallbackRegistered = true
        } catch (_: RuntimeException) {
        }

        if (savedInstanceState != null) web.restoreState(savedInstanceState) else web.loadUrl(SITE.toString())
        startAds()
    }

    /** Load the page again after it failed (the site's own address if the failed one isn't known). */
    private fun retry() {
        if (web.url?.startsWith("https://") == true) web.reload() else web.loadUrl(SITE.toString())
    }

    /** Ask for consent where the law requires it (Google's own form), then show the banner. */
    private fun startAds() {
        val consent = UserMessagingPlatform.getConsentInformation(this)
        consent.requestConsentInfoUpdate(
            this,
            ConsentRequestParameters.Builder().build(),
            {
                UserMessagingPlatform.loadAndShowConsentFormIfRequired(this) {
                    if (consent.canRequestAds()) initAds()
                }
            },
            { if (consent.canRequestAds()) initAds() },
        )
        // Consent given on an earlier run: no need to wait for the update.
        if (consent.canRequestAds()) initAds()
    }

    private fun initAds() {
        if (!adsStarted.compareAndSet(false, true)) return
        MobileAds.initialize(this) {}
        adBox.post { loadBanner() }
    }

    /** An adaptive banner as wide as the screen, at the bottom. */
    private fun loadBanner() {
        val density = resources.displayMetrics.density
        val widthDp = ((adBox.width.takeIf { it > 0 } ?: resources.displayMetrics.widthPixels) / density).toInt()
        if (adView != null && widthDp == bannerWidthDp) return
        bannerWidthDp = widthDp
        adView?.destroy()
        val banner = AdView(this).apply {
            adUnitId = BuildConfig.ADMOB_BANNER_ID
            setAdSize(AdSize.getCurrentOrientationAnchoredAdaptiveBannerAdSize(this@MainActivity, widthDp))
        }
        adBox.removeAllViews()
        adBox.addView(banner)
        banner.loadAd(AdRequest.Builder().build())
        adView = banner
    }

    private fun openOutside(url: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, url))
        } catch (_: ActivityNotFoundException) {
            // Nothing can open it: stay where we are.
        }
    }

    private fun hasLocationPermission() =
        ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != LOCATION_REQUEST) return
        pendingGeo?.let { (origin, callback) -> callback.invoke(origin, hasLocationPermission(), false) }
        pendingGeo = null
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onPause() {
        adView?.pause()
        web.onPause()
        super.onPause()
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
        adView?.resume()
    }

    // A new display size changes the width in dp even when the pixels stay the same.
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        if (adsStarted.get()) adBox.post { loadBanner() }
    }

    override fun onDestroy() {
        if (networkCallbackRegistered) {
            try {
                getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(networkCallback)
            } catch (_: RuntimeException) {
            }
        }
        adView?.destroy()
        web.destroy()
        super.onDestroy()
    }

    private companion object {
        val SITE: Uri = Uri.parse(BuildConfig.SITE_URL)
        const val LOCATION_REQUEST = 1
    }
}
