package me.novarum.incomingcall

import android.content.Context
import dev.djara.expounifiedpush.NotificationContent
import dev.djara.expounifiedpush.PushPayloadRenderer
import org.json.JSONObject

private fun JSONObject.text(key: String) = if (isNull(key)) null else optString(key).ifEmpty { null }

/**
 * Every push from the homeserver comes through here (see anchor's utils/notify.ts). A call rings
 * with our own notification; everything else is shown the way expo-unified-push shows it.
 */
class CallPushRenderer : PushPayloadRenderer {
  override fun render(context: Context, instance: String, decrypted: String): NotificationContent? {
    val data = runCatching { JSONObject(decrypted) }.getOrNull() ?: return null

    if (data.text("type") == "call") {
      val channelId = data.text("channelId") ?: return null
      if (data.optBoolean("ringing")) {
        IncomingCallNotification.show(
          context,
          channelId,
          caller = data.text("title") ?: "Novarum",
          label = data.text("body") ?: "Is calling you",
          avatarUrl = data.text("icon"),
        )
      } else {
        IncomingCallNotification.cancel(context, channelId)
      }
      return null
    }

    if (!data.has("id")) return null
    return NotificationContent(
      id = data.getLong("id").toInt(),
      title = data.text("title"),
      body = data.text("body"),
      imageUrl = data.text("imageUrl"),
      number = if (data.isNull("number")) null else data.getInt("number"),
      silent = if (data.isNull("silent")) null else data.getBoolean("silent"),
      type = data.text("type"),
      url = data.text("url"),
    )
  }
}
