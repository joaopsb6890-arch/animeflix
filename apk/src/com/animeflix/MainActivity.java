package com.animeflix;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.PictureInPictureParams;
import android.content.ClipData;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Rational;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;
import java.util.ArrayList;

public class MainActivity extends Activity {

    private static final String URL = "https://animeflix-8iap.onrender.com/"; // trocado por build_apk.sh (APP_URL)

    private static final String OFFLINE =
            "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>"
            + "<body style='background:#0c0a12;color:#eee;font-family:sans-serif;"
            + "display:flex;align-items:center;justify-content:center;min-height:95vh;margin:0'>"
            + "<div style='max-width:320px;text-align:center;padding:24px'>"
            + "<h2 style='margin:12px 0;font-weight:700'>Sem conex&atilde;o</h2>"
            + "<p style='color:#999;line-height:1.5;font-size:14px'>Confira sua internet e tente de novo.</p>"
            + "<a href='" + URL + "' style='display:inline-block;margin-top:20px;padding:12px 28px;"
            + "background:#e8365f;color:#fff;border-radius:10px;text-decoration:none;"
            + "font-weight:600'>Tentar de novo</a>"
            + "</div></body>";

    private FrameLayout root;
    private WebView web;
    private View customView;
    private WebChromeClient.CustomViewCallback customCb;

    @SuppressLint("SetJavaScriptEnabled")
    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);

        root = new FrameLayout(this);
        web = new WebView(this);
        root.addView(web, match());
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        web.setBackgroundColor(Color.parseColor("#08080a"));
        web.addJavascriptInterface(new Bridge(), "Android");

        web.setWebViewClient(new WebViewClient() {
            @Override public void onReceivedError(WebView v, int code, String desc, String failing) {
                if (failing != null && failing.startsWith(URL)) {
                    v.loadDataWithBaseURL(URL, OFFLINE, "text/html", "utf-8", null);
                }
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onShowCustomView(View view, CustomViewCallback cb) {
                if (customView != null) {
                    cb.onCustomViewHidden();
                    return;
                }
                customView = view;
                customCb = cb;
                web.setVisibility(View.GONE);
                root.addView(view, match());
            }

            @Override public void onHideCustomView() {
                leaveFullscreen();
            }
        });

        web.loadUrl(URL);
    }

    private FrameLayout.LayoutParams match() {
        return new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                                            ViewGroup.LayoutParams.MATCH_PARENT);
    }

    /** Só os métodos marcados com @JavascriptInterface são visíveis para a página. */
    private class Bridge {
        @JavascriptInterface
        public void enterPip(final int w, final int h) {
            runOnUiThread(new Runnable() {
                @Override public void run() { requestPip(w, h); }
            });
        }

        @JavascriptInterface
        public String pipMode() {
            return inPip() ? "1" : "";
        }
    }

    private boolean inPip() {
        return Build.VERSION.SDK_INT >= 26 && isInPictureInPictureMode();
    }

    private void requestPip(int w, int h) {
        if (Build.VERSION.SDK_INT < 26) {
            toast("Picture-in-Picture precisa do Android 8 ou mais novo");
            return;
        }
        /* O Android recusa qualquer proporção fora de 0,41–2,39, e recusar devolve
           false sem explicar: melhor cair para 16:9 do que o botão não fazer nada. */
        double r = h > 0 ? (double) w / h : 0;
        Rational ratio = (r >= 0.41 && r <= 2.39) ? new Rational(w, h) : new Rational(16, 9);
        PictureInPictureParams p =
                new PictureInPictureParams.Builder().setAspectRatio(ratio).build();
        if (!enterPictureInPictureMode(p)) toast("O sistema recusou o Picture-in-Picture");
    }

    private void toast(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
    }

    private void leaveFullscreen() {
        if (customView == null) return;
        root.removeView(customView);
        customView = null;
        web.setVisibility(View.VISIBLE);
        if (customCb != null) {
            customCb.onCustomViewHidden();
            customCb = null;
        }
    }

    @Override public void onBackPressed() {
        if (customView != null) leaveFullscreen();
        else if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override protected void onPause() {
        /* Entrar em PiP também dispara onPause. Pausar aqui congela a janelinha. */
        if (!inPip()) web.onPause();
        super.onPause();
    }

    @Override protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }
}
