package me.novarum.mobile;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import java.nio.charset.StandardCharsets;
import org.json.JSONException;
import org.json.JSONObject;
import org.unifiedpush.android.connector.FailedReason;
import org.unifiedpush.android.connector.PushService;
import org.unifiedpush.android.connector.data.PublicKeySet;
import org.unifiedpush.android.connector.data.PushEndpoint;
import org.unifiedpush.android.connector.data.PushMessage;

/** Receives what the distributor delivers, also while the app is closed. */
public class UnifiedPushService extends PushService {

    static final String EXTRA_URL = "novarum_url";
    private static final String CHANNEL_ID = "messages";

    @Override
    public void onNewEndpoint(@NonNull PushEndpoint endpoint, @NonNull String instance) {
        PublicKeySet keys = endpoint.getPubKeySet();
        if (keys == null) {
            UnifiedPushPlugin.onFailure("NO_KEYS");
            return;
        }
        UnifiedPushPlugin.onEndpoint(this, endpoint.getUrl(), keys.getPubKey(), keys.getAuth());
    }

    @Override
    public void onMessage(@NonNull PushMessage message, @NonNull String instance) {
        // the homeserver always encrypts, so anything we could not decrypt is not ours
        if (!message.getDecrypted()) return;

        try {
            JSONObject payload = new JSONObject(
                new String(message.getContent(), StandardCharsets.UTF_8)
            );
            show(
                payload.optString("title", "Novarum"),
                payload.optString("body", ""),
                payload.optString("tag", ""),
                payload.optString("url", "")
            );
        } catch (JSONException ignored) {}
    }

    @Override
    public void onRegistrationFailed(@NonNull FailedReason reason, @NonNull String instance) {
        UnifiedPushPlugin.onFailure(reason.name());
    }

    @Override
    public void onUnregistered(@NonNull String instance) {
        UnifiedPushPlugin.prefs(this).edit().clear().apply();
    }

    private void show(String title, String body, String tag, String url) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                new NotificationChannel(CHANNEL_ID, "Messages", NotificationManager.IMPORTANCE_HIGH)
            );
        }

        Intent open = new Intent(this, MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(EXTRA_URL, url);
        // the tag is the channel, so a newer message in it replaces the old notification
        int id = tag.hashCode();
        PendingIntent tap = PendingIntent.getActivity(
            this,
            id,
            open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(getApplicationInfo().icon)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(tap)
            .setPriority(NotificationCompat.PRIORITY_HIGH);

        try {
            NotificationManagerCompat.from(this).notify(tag, id, builder.build());
        } catch (SecurityException ignored) {
            // notifications were turned off in the system settings
        }
    }
}
