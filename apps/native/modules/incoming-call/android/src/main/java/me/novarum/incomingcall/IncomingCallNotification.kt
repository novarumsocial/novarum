package me.novarum.incomingcall

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.content.ContextCompat
import androidx.core.graphics.drawable.IconCompat
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/** The ringing notification: a heads-up call with Answer and Decline, and the call screen when locked. */
object IncomingCallNotification {
  private const val CHANNEL = "calls"
  // the homeserver ends a ring after 30 seconds, and so does the app
  private const val RING_MS = 30_000L
  // the theme's primary (apps/frontend/src/routes/layout.css)
  private const val PRIMARY = 0xFF005F78.toInt()
  private val VIBRATION = longArrayOf(0, 500, 300, 500, 1200)

  /** Same id the homeserver puts in the push: a hash of `call:<channelId>`. */
  fun idFor(channelId: String) = "call:$channelId".hashCode() and 0x7fffffff

  fun show(context: Context, channelId: String, caller: String, label: String, avatarUrl: String?) {
    if (
      Build.VERSION.SDK_INT >= 33 &&
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
          PackageManager.PERMISSION_GRANTED
    )
      return
    createChannel(context)

    val id = idFor(channelId)
    val person =
      Person.Builder()
        .setName(caller)
        .setImportant(true)
        .apply { avatarUrl?.let(::loadBitmap)?.let { setIcon(IconCompat.createWithBitmap(it)) } }
        .build()
    val ring = openApp(context, channelId, answer = false)
    val decline =
      PendingIntent.getBroadcast(
        context,
        id,
        Intent(context, DeclineReceiver::class.java).putExtra("channelId", channelId),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
      )

    val notification =
      NotificationCompat.Builder(context, CHANNEL)
        .setSmallIcon(android.R.drawable.sym_call_incoming)
        .setContentTitle(caller)
        .setContentText(label)
        .setCategory(NotificationCompat.CATEGORY_CALL)
        .setPriority(NotificationCompat.PRIORITY_MAX)
        .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
        .setColor(PRIMARY)
        .setColorized(true)
        .setOngoing(true)
        .setTimeoutAfter(RING_MS)
        .setContentIntent(ring)
        // locked: our own call screen comes up (the app over the lock screen); unlocked: a heads-up
        .setFullScreenIntent(ring, true)
        .setStyle(
          NotificationCompat.CallStyle.forIncomingCall(
            person,
            decline,
            openApp(context, channelId, answer = true),
          )
        )
        .addPerson(person)
        .build()
    // keeps ringing until it's answered, declined or times out
    notification.flags = notification.flags or Notification.FLAG_INSISTENT

    runCatching { NotificationManagerCompat.from(context).notify(id, notification) }
  }

  fun cancel(context: Context, channelId: String) =
    NotificationManagerCompat.from(context).cancel(idFor(channelId))

  // novarum://call/<channelId> opens the app's call screen; /answer joins right away
  private fun openApp(context: Context, channelId: String, answer: Boolean): PendingIntent {
    val path = "novarum://call/${Uri.encode(channelId)}" + if (answer) "/answer" else ""
    val intent =
      Intent(Intent.ACTION_VIEW, Uri.parse(path))
        .setPackage(context.packageName)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    return PendingIntent.getActivity(
      context,
      idFor(channelId) + if (answer) 1 else 0,
      intent,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
  }

  private fun createChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val channel =
      NotificationChannel(CHANNEL, "Calls", NotificationManager.IMPORTANCE_HIGH).apply {
        description = "Someone calling you in a direct message or group"
        setSound(
          RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build(),
        )
        enableVibration(true)
        vibrationPattern = VIBRATION
        lockscreenVisibility = Notification.VISIBILITY_PUBLIC
      }
    context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
  }

  // the caller's avatar, if it comes quickly: the phone should ring now, not after a slow download
  private fun loadBitmap(url: String): Bitmap? {
    var bitmap: Bitmap? = null
    thread {
        runCatching {
          val connection = URL(url).openConnection() as HttpURLConnection
          connection.connectTimeout = 2000
          connection.readTimeout = 2000
          bitmap = connection.inputStream.use(BitmapFactory::decodeStream)
          connection.disconnect()
        }
      }
      .join(3000)
    return bitmap
  }
}
