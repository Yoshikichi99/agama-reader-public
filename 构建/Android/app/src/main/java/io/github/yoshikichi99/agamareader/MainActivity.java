package io.github.yoshikichi99.agamareader;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * 壳只做四件事：
 * 1. 起一个 WebView，把 https://appassets.androidplatform.net/ 映射到 APK 的 assets/；
 * 2. 不改前端代码——与浏览器里预览的是同一份 前端/proto；
 * 3. 返回键 → history.back()，到首页再按才退出；
 * 4. Android 15+ 强制 edge-to-edge，这里给 WebView 补状态栏/导航栏安全区。
 *
 * 故意不引 AndroidX：资源映射自己实现（shouldInterceptRequest），
 * 比 WebViewAssetLoader 少一个依赖，APK 也小一点。
 */
public class MainActivity extends Activity {

    private static final String HOST = "appassets.androidplatform.net";
    private static final String ENTRY = "https://" + HOST + "/index.html";

    /** 页面底色，与 style.css 的 --paper 一致，避免启动白闪 */
    private static final int PAPER = 0xFFF7F0E3;
    private static final int GROUND = 0xFFEFE6D4;
    private static final int PAPER_DARK = 0xFF15120F;
    private static final int GROUND_DARK = 0xFF1B1611;

    private FrameLayout root;

    private static final int REQ_EXPORT = 1001;
    private static final int REQ_IMPORT = 1002;
    private static final int REQ_FONT = 1003;

    private WebView web;
    private volatile boolean volTurn = false;   // 音量键翻页开关
    private volatile boolean paged = false;     // 当前是否左右翻页
    private String pendingName;
    private String pendingContent;

    private boolean isSystemDark() {
        int mode = getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        return mode == Configuration.UI_MODE_NIGHT_YES;
    }

    /** WebView 的 prefers-color-scheme 在部分 ROM 上不跟系统；由原生把真实值推给前端。 */
    private void pushSystemDark() {
        if (web == null) return;
        final boolean dark = isSystemDark();
        web.post(() -> web.evaluateJavascript(
                "window.ARIO_onSystemDark && window.ARIO_onSystemDark(" + dark + ")", null));
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        pushSystemDark();
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 调试包开 WebView 调试，可以用 chrome://inspect 或 cdp_eval.js 读真实布局
        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);       // 简繁选择、阅读记录、经后笔记都用 localStorage
        // 必须开：否则 index.html 的 viewport 不生效，页面按桌面宽度布局、横向溢出
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setTextZoom(100);                 // 不受系统字体缩放影响，字号由页面自己控
        s.setAllowFileAccess(false);
        // 资源都在 APK 里，没有联网收益；不关缓存的话升级后仍会读到旧的 style.css/app.js
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        s.setAllowContentAccess(false);
        s.setSupportZoom(false);            // 缩放由字号档位控制，不用双指
        s.setBuiltInZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        web.setBackgroundColor(PAPER);
        web.setWebViewClient(new LocalClient());
        // 文件导入/导出走 SAF：系统选择器逐次授权，App 不申请任何存储权限
        web.addJavascriptInterface(new Bridge(), "ARIO");

        root = new FrameLayout(this);
        root.setBackgroundColor(PAPER);   // 安全区与页面同色，否则顶部会多一条色带
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
        applyInsets(root);

        web.loadUrl(ENTRY);
    }

    /**
     * Android 15（API 35）起，targetSdk>=35 的窗口强制 edge-to-edge。
     * 注意：WebView 的 padding 不会缩进网页视口（页面仍按整块 View 布局），
     * 所以这里给 WebView 设真实的外边距，让网页视口本身落在安全区内，
     * 顶栏 position:sticky 才会自然地停在状态栏下方。
     */
    private void applyInsets(FrameLayout root) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((v, wi) -> {
                Insets bars = wi.getInsets(
                        WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                Insets gestures = wi.getInsets(WindowInsets.Type.mandatorySystemGestures());
                ViewGroup.LayoutParams lp = web.getLayoutParams();
                if (lp instanceof ViewGroup.MarginLayoutParams) {
                    ViewGroup.MarginLayoutParams m = (ViewGroup.MarginLayoutParams) lp;
                    m.topMargin = bars.top;
                    m.leftMargin = bars.left;
                    m.rightMargin = bars.right;
                    m.bottomMargin = Math.max(bars.bottom, gestures.bottom);
                    web.setLayoutParams(m);
                }
                return wi;
            });
            root.requestApplyInsets();
        }
    }

    /**
     * 返回键 = 回上一层，不是回浏览历史。
     * 交给页面算父级（經文 → 品 → 部 → 組 → 首頁），页面返回空串才退出程序。
     * 这样在阅读页按返回，回到的是「这部经所在的品」，符合读经时脑子里的树，
     * 而不是浏览器的调用栈。
     */
    /**
     * 音量键翻页：只在「开了开关 + 正在左右翻页」时拦截，其余时候照常调音量。
     * 拦截后交给页面里的 __pageTurn()，返回 true 表示已消费。
     */
    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (volTurn && paged && web != null
                && (keyCode == KeyEvent.KEYCODE_VOLUME_UP || keyCode == KeyEvent.KEYCODE_VOLUME_DOWN)) {
            final int dir = (keyCode == KeyEvent.KEYCODE_VOLUME_DOWN) ? 1 : -1;
            web.evaluateJavascript("(window.__pageTurn ? window.__pageTurn(" + dir + ") : 0)", null);
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public void onBackPressed() {
        if (web == null) {
            super.onBackPressed();
            return;
        }
        web.evaluateJavascript("(window.ARUp ? window.ARUp() : '')", value -> {
            if (value == null || "null".equals(value) || "\"\"".equals(value)) {
                MainActivity.super.onBackPressed();
            }
        });
    }

    private class LocalClient extends WebViewClient {

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            pushSystemDark();
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            if (!HOST.equals(u.getHost())) return null;
            String path = u.getPath();
            if (path == null || path.length() < 2) return null;
            String asset = path.substring(1);       // "/data/canon.json.gz" -> "data/canon.json.gz"
            // 打包时 .gz 被改名成 .gz.bin（躲开 AGP 的自动解压），这里映射回去
            if (asset.endsWith(".gz")) asset = asset + ".bin";
            try {
                InputStream in = getAssets().open(asset);
                String mime = guessMime(asset);
                // 文本给编码，二进制给 null（否则 WebView 会按文本转码）
                String encoding = isText(mime) ? "utf-8" : null;
                return new WebResourceResponse(mime, encoding, in);
            } catch (IOException e) {
                return null;                        // 交给默认处理（表现为 404）
            }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            if (HOST.equals(u.getHost())) return false;   // 站内 hash 路由，交给页面
            // 离线版不申请 INTERNET 权限，外部链接也不放行
            Toast.makeText(MainActivity.this,
                    "離線版不連網，外部連結已停用", Toast.LENGTH_SHORT).show();
            return true;
        }
    }

    /* ---------- 文件桥接：SAF，零权限 ----------
     * ACTION_CREATE_DOCUMENT / ACTION_OPEN_DOCUMENT 由系统选择器逐次授权，
     * App 不申请任何存储权限，也拿不到目录的读权限。
     */
    class Bridge {
        @JavascriptInterface
        public void export(final String name, final String mime, final String content) {
            runOnUiThread(() -> {
                pendingName = name;
                pendingContent = content;
                Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType(mime == null ? "application/json" : mime);
                i.putExtra(Intent.EXTRA_TITLE, name);
                try {
                    startActivityForResult(i, REQ_EXPORT);
                } catch (Exception e) {
                    toastShort("沒有可用的檔案儲存程式");
                }
            });
        }

        /** 阅读页隐藏状态栏；顶部下滑可临时调出，退出阅读页恢复。0 权限。 */
        @JavascriptInterface
        public void setImmersive(final boolean on) {
            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    android.view.WindowInsetsController c = getWindow().getInsetsController();
                    if (c == null) return;
                    if (on) {
                        c.setSystemBarsBehavior(
                                android.view.WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                        c.hide(WindowInsets.Type.statusBars());
                    } else {
                        c.show(WindowInsets.Type.statusBars());
                    }
                } else {
                    android.view.View dv = getWindow().getDecorView();
                    int f = dv.getSystemUiVisibility();
                    if (on) {
                        f |= android.view.View.SYSTEM_UI_FLAG_FULLSCREEN
                                | android.view.View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY;
                    } else {
                        f &= ~(android.view.View.SYSTEM_UI_FLAG_FULLSCREEN
                                | android.view.View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
                    }
                    dv.setSystemUiVisibility(f);
                }
            });
        }

        /** 屏幕常亮：阅读时不让系统熄屏（0 权限，只是窗口标志） */
        /** 深色模式：把窗口底色与状态栏图标一起换掉（安全区是原生画的，CSS 管不到） */
        @JavascriptInterface
        public void setChrome(final boolean dark) {
            runOnUiThread(() -> {
                web.setBackgroundColor(dark ? PAPER_DARK : PAPER);
                if (root != null) root.setBackgroundColor(dark ? PAPER_DARK : PAPER);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    android.view.WindowInsetsController c = getWindow().getInsetsController();
                    if (c != null) {
                        int mask = android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                                | android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                        c.setSystemBarsAppearance(dark ? 0 : mask, mask);
                    }
                } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    android.view.View dv = getWindow().getDecorView();
                    int f = dv.getSystemUiVisibility();
                    if (dark) f &= ~android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                    else f |= android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                    dv.setSystemUiVisibility(f);
                }
            });
        }

        /** 音量键翻页：两个状态都由页面给，缺一不生效 */
        @JavascriptInterface
        public void setVolumeTurn(final boolean on) { volTurn = on; }

        @JavascriptInterface
        public void setPaged(final boolean on) { paged = on; }

        @JavascriptInterface
        public void keepScreen(final boolean on) {
            runOnUiThread(() -> {
                if (on) {
                    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                } else {
                    getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
            });
        }

        @JavascriptInterface
        public void pick() {            runOnUiThread(() -> {
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                try {
                    startActivityForResult(i, REQ_IMPORT);
                } catch (Exception e) {
                    toastShort("沒有可用的檔案選擇程式");
                }
            });
        }

        @JavascriptInterface
        public void pickFont() {        runOnUiThread(() -> {
            Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType("*/*");
            try {
                startActivityForResult(i, REQ_FONT);
            } catch (Exception e) {
                toastShort("沒有可用的檔案選擇程式");
            }
        });
        }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (res != RESULT_OK || data == null) return;
        Uri uri = data.getData();
        if (uri == null) return;
        if (req == REQ_EXPORT) {
            try (OutputStream os = getContentResolver().openOutputStream(uri)) {
                if (os == null) throw new IOException("無法寫入");
                String body = pendingContent == null ? "" : pendingContent;
                os.write(body.getBytes("UTF-8"));
                toastShort("已導出：" + pendingName);
            } catch (Exception e) {
                toastShort("導出失敗：" + e.getMessage());
            } finally {
                pendingContent = null;
            }
        } else if (req == REQ_IMPORT) {
            try (InputStream in = getContentResolver().openInputStream(uri)) {
                if (in == null) throw new IOException("無法讀取");
                final String text = readAll(in);
                final String js = "window.ARIO_onFile(" + JSONObject.quote(text) + ")";
                web.post(() -> web.evaluateJavascript(js, null));
            } catch (Exception e) {
                toastShort("讀取失敗：" + e.getMessage());
            }
        } else if (req == REQ_FONT) {
            try (InputStream in = getContentResolver().openInputStream(uri)) {
                if (in == null) throw new IOException("無法讀取");
                byte[] bytes = readBytes(in, 12 * 1024 * 1024);
                String name = "font.ttf";
                try (android.database.Cursor c = getContentResolver().query(uri, null, null, null, null)) {
                    if (c != null && c.moveToFirst()) {
                        int ci = c.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME);
                        if (ci >= 0) name = c.getString(ci);
                    }
                }
                final String b64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP);
                final String js = "window.ARIO_onFont(" + JSONObject.quote(name) + "," + JSONObject.quote(b64) + ")";
                web.post(() -> web.evaluateJavascript(js, null));
            } catch (Exception e) {
                toastShort("字體讀取失敗：" + e.getMessage());
            }
        }
    }

    private static byte[] readBytes(InputStream in, int max) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) {
            if (bos.size() + n > max) throw new IOException("字體檔案超過 12 MB");
            bos.write(buf, 0, n);
        }
        return bos.toByteArray();
    }

    private static String readAll(InputStream in) throws IOException {
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        return new String(bos.toByteArray(), "UTF-8");
    }

    private void toastShort(String m) {
        Toast.makeText(this, m, Toast.LENGTH_SHORT).show();
    }

    private static boolean isText(String mime) {        return mime.startsWith("text/") || mime.equals("application/javascript")
                || mime.equals("application/json");
    }

    private static String guessMime(String name) {
        String n = name.toLowerCase();
        if (n.endsWith(".html") || n.endsWith(".htm")) return "text/html";
        if (n.endsWith(".js")) return "application/javascript";
        if (n.endsWith(".css")) return "text/css";
        if (n.endsWith(".json")) return "application/json";
        if (n.endsWith(".json.gz") || n.endsWith(".gz")) return "application/gzip";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".gif")) return "image/gif";
        if (n.endsWith(".svg")) return "image/svg+xml";
        if (n.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }
}
