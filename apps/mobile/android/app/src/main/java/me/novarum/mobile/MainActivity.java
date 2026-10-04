package me.novarum.mobile;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(UnifiedPushPlugin.class);
        super.onCreate(savedInstanceState);
        // a notification tapped while the app was closed: JS asks for it once it has loaded
        String url = getIntent().getStringExtra(UnifiedPushService.EXTRA_URL);
        UnifiedPushPlugin.launchUrl =
            url != null && url.matches(UnifiedPushService.URL_PATTERN) ? url : null;
    }
}
