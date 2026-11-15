# 构建说明

本项目不附带 Gradle Wrapper，请使用下表中的版本自行下载 Gradle。

## 测试环境

| 工具 | 版本 |
|---|---|
| JDK | 17 |
| Gradle | 8.9 |
| Android Gradle Plugin | 8.7.3 |
| Android SDK Platform | 35 |
| Android SDK Build-Tools | 35.0.0 |
| minSdk | 24 |

## 准备

1. 安装 JDK 17，设置 `JAVA_HOME`。
2. 安装 Android SDK Platform 35 与 Build-Tools 35.0.0，设置 `ANDROID_HOME`
   （或 `ANDROID_SDK_ROOT`）。
3. 从 <https://gradle.org/releases/> 下载 Gradle 8.9，解压后把 `bin` 加入 `PATH`。

## 构建 debug

```bash
cd 构建/Android
gradle :app:assembleDebug
```

输出：

```text
构建/Android/app/build/outputs/apk/debug/app-debug.apk
```

运行数据已经包含在 `前端/proto/data`；`syncAssets` 会在构建时把
`前端/proto` 同步进 APK，不需要先跑数据清洗脚本。

## 构建 release

仓库不包含维护者的签名钥匙。请使用自己的 keystore 配置签名，例如在
`构建/Android/app/build.gradle` 的 `signingConfigs` 中填入自己的路径与密码，
或在本地通过环境变量/外部 properties 注入。

```bash
cd 构建/Android
gradle :app:assembleRelease
```

没有配置签名时，产物是未签名 release；不要把它当成可直接分发的安装包。

## 常见问题

- **路径含中文**：`gradle.properties` 已设置 `android.overridePathCheck=true`。
- **Gradle 版本不对**：AGP 8.7.3 需要 Gradle 8.9；不要用系统自带的旧 Gradle。
- **Android SDK 找不到**：确认 `ANDROID_HOME` 指向包含 `platforms/android-35`
  和 `build-tools/35.0.0` 的 SDK 目录。
