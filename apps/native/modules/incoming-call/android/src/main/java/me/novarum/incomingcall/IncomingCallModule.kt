package me.novarum.incomingcall

import android.app.KeyguardManager
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class IncomingCallModule : Module() {
  private val context
    get() = requireNotNull(appContext.reactContext)

  override fun definition() = ModuleDefinition {
    Name("IncomingCall")

    // the call is handled in the app: the notification goes away
    Function("cancel") { channelId: String -> IncomingCallNotification.cancel(context, channelId) }

    Function("isLocked") {
      context.getSystemService(KeyguardManager::class.java).isKeyguardLocked
    }

    // answered on the lock screen: ask to unlock, and stop showing over the lock screen either way
    Function("unlock") {
      val activity = appContext.currentActivity ?: return@Function
      activity.runOnUiThread {
        val keyguard = activity.getSystemService(KeyguardManager::class.java)
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
          LockScreen.showOverLockScreen(activity, false)
          return@runOnUiThread
        }
        keyguard.requestDismissKeyguard(
          activity,
          object : KeyguardManager.KeyguardDismissCallback() {
            override fun onDismissSucceeded() = LockScreen.showOverLockScreen(activity, false)

            override fun onDismissCancelled() = LockScreen.showOverLockScreen(activity, false)

            override fun onDismissError() = LockScreen.showOverLockScreen(activity, false)
          },
        )
      }
    }

    // declined or missed: the lock screen comes back, with the app behind it
    Function("release") {
      val activity = appContext.currentActivity ?: return@Function
      activity.runOnUiThread {
        val locked = activity.getSystemService(KeyguardManager::class.java).isKeyguardLocked
        LockScreen.showOverLockScreen(activity, false)
        if (locked) activity.moveTaskToBack(true)
      }
    }
  }
}
