package me.novarum.incomingcall

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import expo.modules.core.interfaces.Package
import expo.modules.core.interfaces.ReactActivityLifecycleListener
import java.lang.ref.WeakReference

class IncomingCallPackage : Package {
  override fun createReactActivityLifecycleListeners(
    activityContext: Context
  ): List<ReactActivityLifecycleListener> = listOf(LockScreen)
}

/**
 * The ring notification opens novarum://call/<channelId>. Only then does the app show over the lock
 * screen, until the person answers (and unlocks) or declines: see IncomingCallModule.
 */
object LockScreen : ReactActivityLifecycleListener {
  private var activity = WeakReference<Activity>(null)

  override fun onCreate(activity: Activity, savedInstanceState: Bundle?) {
    this.activity = WeakReference(activity)
    handle(activity, activity.intent)
  }

  override fun onNewIntent(intent: Intent): Boolean {
    activity.get()?.let { handle(it, intent) }
    return false
  }

  private fun handle(activity: Activity, intent: Intent?) {
    val uri = intent?.data ?: return
    if (uri.scheme != "novarum" || uri.host != "call") return
    val channelId = uri.pathSegments.firstOrNull() ?: return
    // answering from the notification already asked to unlock
    if (uri.pathSegments.getOrNull(1) == "answer") IncomingCallNotification.cancel(activity, channelId)
    else showOverLockScreen(activity, true)
  }

  @Suppress("DEPRECATION")
  fun showOverLockScreen(activity: Activity, show: Boolean) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      activity.setShowWhenLocked(show)
      activity.setTurnScreenOn(show)
    } else {
      val flags = WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
      if (show) activity.window.addFlags(flags) else activity.window.clearFlags(flags)
    }
  }
}
