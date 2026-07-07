plugins {
    alias(libs.plugins.android.application)
    // AGP 9 compiles Kotlin natively (built-in Kotlin); only the Compose
    // compiler still comes from its own plugin.
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "com.trylonghand.longhand.example"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.trylonghand.longhand.example"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
    }
}

dependencies {
    // Substituted onto the repo root build by includeBuild in settings;
    // a standalone app would resolve these from JitPack instead.
    implementation("com.trylonghand:ink-core:0.1.0")
    implementation("com.trylonghand:ink-graves:0.1.0")
    implementation("com.trylonghand:ink-calligrapher:0.1.0")
    implementation("com.trylonghand:ink-render:0.1.0")

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.compose.material3)
}
