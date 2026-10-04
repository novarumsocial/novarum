package me.novarum.mobile;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import kotlin.Unit;
import org.unifiedpush.android.connector.ConstantsKt;
import org.unifiedpush.android.connector.UnifiedPush;

/**
 * Push on Android through UnifiedPush: the user's distributor (ntfy, ...) hands us a Web Push endpoint
 * and keys, JS gives them to the homeserver, and the homeserver pushes to it like to any browser. The
 * messages arrive in {@link UnifiedPushService}, so notifications show with the app closed.
 */
@CapacitorPlugin(
    name = "UnifiedPush",
    permissions = {
        @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications")
    }
)
public class UnifiedPushPlugin extends Plugin {

    private static final String PREFS = "novarum_unifiedpush";

    // set while the webview is alive, so the service can tell JS about new endpoints
    static UnifiedPushPlugin instance;
    // the url of the notification that launched the app, handed to JS once
    static String launchUrl;

    @Override
    public void load() {
        instance = this;
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        String url = intent.getStringExtra(UnifiedPushService.EXTRA_URL);
        if (url == null) return;
        JSObject data = new JSObject();
        data.put("url", url);
        notifyListeners("notificationTapped", data);
    }

    @PluginMethod
    public void register(PluginCall call) {
        if (
            Build.VERSION.SDK_INT >= 33 &&
            getPermissionState("notifications") != PermissionState.GRANTED
        ) {
            requestPermissionForAlias("notifications", call, "registerAfterPermission");
            return;
        }
        registerWithDistributor(call);
    }

    @PermissionCallback
    private void registerAfterPermission(PluginCall call) {
        if (getPermissionState("notifications") == PermissionState.GRANTED) {
            registerWithDistributor(call);
        } else {
            call.reject("Notifications are not allowed", "PERMISSION_DENIED");
        }
    }

    // resolves once the request is sent; the endpoint itself arrives as an "endpoint" event
    private void registerWithDistributor(PluginCall call) {
        String vapid = call.getString("vapid");
        Activity activity = getActivity();
        UnifiedPush.tryUseCurrentOrDefaultDistributor(
            activity,
            success -> {
                if (!success) {
                    call.reject("No UnifiedPush distributor is installed", "NO_DISTRIBUTOR");
                    return Unit.INSTANCE;
                }
                try {
                    UnifiedPush.register(
                        getContext(),
                        ConstantsKt.INSTANCE_DEFAULT,
                        "Novarum",
                        vapid
                    );
                    call.resolve();
                } catch (Exception e) {
                    call.reject("Could not register: " + e.getMessage(), "REGISTRATION_FAILED");
                }
                return Unit.INSTANCE;
            }
        );
    }

    @PluginMethod
    public void unregister(PluginCall call) {
        UnifiedPush.unregister(getContext(), ConstantsKt.INSTANCE_DEFAULT);
        prefs(getContext()).edit().clear().apply();
        call.resolve();
    }

    // the last endpoint we were given, so the app can re-send it to the homeserver on start
    @PluginMethod
    public void getEndpoint(PluginCall call) {
        call.resolve(endpointData(prefs(getContext())));
    }

    @PluginMethod
    public void getLaunchUrl(PluginCall call) {
        JSObject result = new JSObject();
        result.put("url", launchUrl);
        launchUrl = null;
        call.resolve(result);
    }

    static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static JSObject endpointData(SharedPreferences prefs) {
        JSObject data = new JSObject();
        String endpoint = prefs.getString("endpoint", null);
        if (endpoint != null) {
            data.put("endpoint", endpoint);
            data.put("p256dh", prefs.getString("p256dh", null));
            data.put("auth", prefs.getString("auth", null));
        }
        return data;
    }

    static void onEndpoint(Context context, String endpoint, String p256dh, String auth) {
        SharedPreferences prefs = prefs(context);
        prefs
            .edit()
            .putString("endpoint", endpoint)
            .putString("p256dh", p256dh)
            .putString("auth", auth)
            .apply();
        if (instance != null) instance.notifyListeners("endpoint", endpointData(prefs), true);
    }

    static void onFailure(String reason) {
        JSObject data = new JSObject();
        data.put("reason", reason);
        if (instance != null) instance.notifyListeners("registrationFailed", data, true);
    }
}
