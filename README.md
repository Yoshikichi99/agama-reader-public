# 掌上阿含

一部**离线**的阿含经读本。漢譯经文为主，南北传对读、巴利原文、词条注释随手可得。

## 它是什么

- **只收经文与注释**。没有故事选、没有导读文章，翻开就是经。
- 数据来自莊春江「阿含經」網站（[agama.buddhason.org](https://agama.buddhason.org)）。
- 漢譯四阿含与别译杂阿含，全站 **7,570 经**（7,564 页；4 个合并页覆盖 6 经）。

## 特点

| | |
|---|---|
| **完全离线** | 经文、注释、巴利原文都在安装包里，不联网也能用 |
| **南北传对读** | 对读直接在本页展开，不用跳来跳去 |
| **巴利附直译** | 相应部巴利原文逐段附中文直译，可随「译文」开关一起隐藏 |
| **四套经号** | 大正藏／正聞本／佛光本，一键切换 |
| **干净** | 无账号、无广告、无统计、无多余权限 |
| **读得下去** | 字号行距可调、深色模式、左右翻页、音量键翻页 |
| **笔记只在本机** | 高亮与笔记都存在设备上，不上传、不联网 |

## 安装

安装包与更新说明见 [Releases](https://github.com/Yoshikichi99/agama-reader-public/releases)。
不上架应用商店；Android 直接安装 APK。

## 许可

本项目分层授权——程式与经文不是一回事：

| 层 | 许可 |
|---|---|
| 程式 | **AGPL-3.0** |
| 经文、注释、巴利原文 | **CC BY-NC-SA 4.0**（莊春江） |
| 巴利逐段直译（相应部） | **CC BY-NC-SA 4.0**（昭 同修提供，AI 批量处理） |
| 古今对译 / 翻译包 | **CC BY-NC-SA 4.0**（昭 同修提供） |
| 项目说明文档 | CC BY 4.0 |
| 内置字体 | SIL OFL 1.1（Noto Serif SC 子集；HanaMin / Noto Sans Math 补扩展字） |

经文与注释的著作权属莊春江，本项目只是重排与呈现，**不因此改变其授权**。
详见 [LICENSE](LICENSE)、`文档/授权与来源.md` 与 [`文档/使用协议.md`](文档/使用协议.md)。

> **巴利直译声明**：相应部的巴利逐段直译为 **AI 批量处理结果**，由 **昭 同修** 提供，
> 未经逐句人工校对，**不保证准确**，仅供参考。如有同修愿意提供质量更可靠的对译本，
> 欢迎通过授权页的联系方式告知。

> 昭 同修 的佛经在线阅读网站：[古籍对照](https://gujiduizhao.com/AGAMA)

## 构建

运行数据已随源码提供在 `前端/proto/data`，不需要先跑清洗或打包脚本。

测试过的构建环境：

- JDK 17
- Android SDK Platform 35 / Build-Tools 35.0.0
- Gradle 8.9
- Android Gradle Plugin 8.7.3（`构建/Android/build.gradle` 已声明）

```bash
cd 构建/Android
gradle :app:assembleDebug
```

仓库不提供维护者的 release 签名钥匙。要构建 release，请配置自己的
`signingConfig`；`app/build.gradle` 检测到外部 `agama-keystore.properties`
时会自动签名，没有钥匙则只能构建 debug 或未签名 release。

更细的版本说明见 [`BUILDING.md`](BUILDING.md)。
