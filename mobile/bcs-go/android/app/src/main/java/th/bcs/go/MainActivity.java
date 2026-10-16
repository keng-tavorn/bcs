package th.bcs.go;

import android.os.Bundle;
import android.webkit.WebView;
import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.BridgeActivity;

// BCS Go (ADR-163): Capacitor's activity, opening the BCS web of one environment. No business code lives here.
// S17-15 (ADR-166, BR-AUTH-09): the WebView may use the passkeys of the web's domain — the fingerprint, face or screen
// lock of the phone confirms an approval — through androidx.webkit's WebAuthn support for apps, which Android allows for
// a domain whose /.well-known/assetlinks.json names this app (S17-09). On a WebView too old for it nothing changes: the
// web finds no WebAuthn and offers the PIN.
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView webView = getBridge().getWebView();
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_AUTHENTICATION)) {
            WebSettingsCompat.setWebAuthenticationSupport(webView.getSettings(), WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_APP);
        }
    }
}
