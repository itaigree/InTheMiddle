package io.github.itaigree.inthemiddle

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.webkit.GeolocationPermissions
import android.webkit.WebChromeClient
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
    private var adView: AdView? = null
    private val adsStarted = AtomicBoolean(false)

    // "My location" on the site waits for Android's permission.
    private var pendingGeo: Pair<String, GeolocationPermissions.Callback>? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        web = findViewById(R.id.web)
        adBox = findViewById(R.id.ad)

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
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })

        if (savedInstanceState != null) web.restoreState(savedInstanceState) else web.loadUrl(SITE.toString())
        startAds()
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

    override fun onDestroy() {
        adView?.destroy()
        web.destroy()
        super.onDestroy()
    }

    private companion object {
        val SITE: Uri = Uri.parse(BuildConfig.SITE_URL)
        const val LOCATION_REQUEST = 1
    }
}
