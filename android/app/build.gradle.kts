plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// AdMob IDs: Google's test IDs unless the real ones are given (-PadmobAppId=…
// -PadmobBannerId=…, from the repository's settings in CI). Debug builds always
// show test ads: clicking your own real ads can get the account closed.
val testAppId = "ca-app-pub-3940256099942544~3347511713"
val testBannerId = "ca-app-pub-3940256099942544/9214589741"
val admobAppId = (findProperty("admobAppId") as String?)?.takeIf { it.isNotBlank() } ?: testAppId
val admobBannerId = (findProperty("admobBannerId") as String?)?.takeIf { it.isNotBlank() } ?: testBannerId

// Signing for upload to Google Play, when the upload key is given (CI secrets).
val keystoreFile = System.getenv("UPLOAD_KEYSTORE_FILE")?.let { file(it) }?.takeIf { it.exists() }

android {
    namespace = "io.github.itaigree.inthemiddle"
    compileSdk = 36

    defaultConfig {
        applicationId = "io.github.itaigree.inthemiddle"
        minSdk = 24
        targetSdk = 36
        versionCode = (findProperty("versionCode") as String?)?.toIntOrNull() ?: 1
        versionName = (findProperty("versionName") as String?) ?: "1.0"
        buildConfigField("String", "SITE_URL", "\"https://itaigree.github.io/InTheMiddle/\"")
    }

    signingConfigs {
        if (keystoreFile != null) {
            create("upload") {
                storeFile = keystoreFile
                storePassword = System.getenv("UPLOAD_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("UPLOAD_KEY_ALIAS")
                keyPassword = System.getenv("UPLOAD_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        debug {
            manifestPlaceholders["admobAppId"] = testAppId
            buildConfigField("String", "ADMOB_BANNER_ID", "\"$testBannerId\"")
        }
        release {
            isMinifyEnabled = false
            manifestPlaceholders["admobAppId"] = admobAppId
            buildConfigField("String", "ADMOB_BANNER_ID", "\"$admobBannerId\"")
            if (keystoreFile != null) signingConfig = signingConfigs.getByName("upload")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("com.google.android.gms:play-services-ads:24.4.0")
    implementation("com.google.android.ump:user-messaging-platform:3.2.0")
}
