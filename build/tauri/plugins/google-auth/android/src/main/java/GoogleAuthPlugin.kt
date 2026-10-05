package app.tauri.googleauth

import android.app.Activity
import android.content.Intent
import androidx.activity.result.ActivityResult
import androidx.activity.result.IntentSenderRequest
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.AuthorizationResult
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.common.api.Scope

@TauriPlugin
class GoogleAuthPlugin(private val activity: Activity) : Plugin(activity) {
    @Command
    fun authorize(invoke: Invoke) {
        val request = AuthorizationRequest.builder()
            .setRequestedScopes(listOf(Scope("https://www.googleapis.com/auth/drive.readonly")))
            .build()

        Identity.getAuthorizationClient(activity)
            .authorize(request)
            .addOnSuccessListener { authorizationResult ->
                if (authorizationResult.hasResolution()) {
                    val pendingIntent = authorizationResult.pendingIntent
                    if (pendingIntent == null) {
                        invoke.reject("Google authorization could not be started.")
                        return@addOnSuccessListener
                    }
                    startIntentSenderForResult(
                        invoke,
                        IntentSenderRequest.Builder(pendingIntent.intentSender).build(),
                        "onAuthorizationResult"
                    )
                } else {
                    resolveAuthorization(invoke, authorizationResult)
                }
            }
            .addOnFailureListener { error ->
                invoke.reject(error.message ?: "Google authorization failed.", error)
            }
    }

    @ActivityCallback
    private fun onAuthorizationResult(invoke: Invoke, result: ActivityResult) {
        if (result.resultCode != Activity.RESULT_OK || result.data == null) {
            invoke.reject("Google authorization was cancelled.")
            return;
        }

        try {
            val authorizationResult = Identity.getAuthorizationClient(activity)
                .getAuthorizationResultFromIntent(result.data)
            resolveAuthorization(invoke, authorizationResult)
        } catch (error: ApiException) {
            invoke.reject(error.message ?: "Google authorization failed.", error)
        }
    }

    private fun resolveAuthorization(invoke: Invoke, result: AuthorizationResult) {
        val accessToken = result.accessToken
        if (accessToken.isNullOrBlank()) {
            invoke.reject("Google authorization did not return an access token.")
            return;
        }

        invoke.resolve(JSObject().apply {
            put("accessToken", accessToken)
            put("expiresIn", 3600)
        })
    }
}