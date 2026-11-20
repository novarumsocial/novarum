package me.novarum.incomingcall

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * "Decline" on the notification, without opening the app: stops ringing here, and tells the
 * homeserver through the signed link in the push, so my other devices stop and, in a 1:1, the caller.
 */
class DeclineReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val channelId = intent.getStringExtra("channelId") ?: return
    IncomingCallNotification.cancel(context, channelId)

    val declineUrl = intent.getStringExtra("declineUrl") ?: return
    val pending = goAsync()
    thread {
      runCatching {
        val connection = URL(declineUrl).openConnection() as HttpURLConnection
        connection.requestMethod = "POST"
        connection.connectTimeout = 5000
        connection.readTimeout = 5000
        connection.responseCode
        connection.disconnect()
      }
      pending.finish()
    }
  }
}
