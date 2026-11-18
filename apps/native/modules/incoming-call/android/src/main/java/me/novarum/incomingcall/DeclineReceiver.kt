package me.novarum.incomingcall

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** "Decline" on the notification: stops ringing on this phone without opening the app. */
class DeclineReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val channelId = intent.getStringExtra("channelId") ?: return
    IncomingCallNotification.cancel(context, channelId)
  }
}
