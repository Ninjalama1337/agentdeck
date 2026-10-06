package com.ninjalama.agentdeck;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

/**
 * Receives FCM messages. Everything goes to the Capacitor push plugin as
 * before, except data-only messages for a terminal that asks a yes/no
 * question or a chat session that asks for a permission: those are drawn
 * here, with Yes / No or Allow / Deny buttons (AnswerReceiver).
 * The system cannot add buttons to a notification it renders for a closed app.
 */
public class AgentDeckMessagingService extends MessagingService {

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        Map<String, String> data = message.getData();
        boolean terminalQuestion = data.containsKey("terminalId") && data.containsKey("prompt");
        boolean permissionQuestion = data.containsKey("sessionId") && data.containsKey("permissionId");
        if (message.getNotification() == null && (terminalQuestion || permissionQuestion)) {
            // In front, the socket already told the user (toast + inbox).
            if (!MainActivity.visible) showWithActions(this, data);
            return;
        }
        super.onMessageReceived(message);
    }

    static void ensureChannel(Context context, String id) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(id) != null) return;
        String name = "Agent alerts";
        if ("agentdeck-done".equals(id)) name = "Agent finished";
        else if ("agentdeck-waiting".equals(id)) name = "Agent needs input";
        else if ("agentdeck-limit".equals(id)) name = "Usage limit reached";
        NotificationChannel channel = new NotificationChannel(id, name, NotificationManager.IMPORTANCE_HIGH);
        channel.enableVibration(true);
        nm.createNotificationChannel(channel);
    }

    private static PendingIntent answerIntent(Context context, Map<String, String> data, String answer, String channel) {
        // One of the two: a terminal question, or a session's permission request.
        String terminalId = data.get("terminalId");
        String target = terminalId != null ? terminalId : data.get("permissionId");
        Intent intent = new Intent(context, AnswerReceiver.class);
        intent.setAction("com.ninjalama.agentdeck.ANSWER." + answer);
        intent.putExtra("terminalId", terminalId);
        intent.putExtra("prompt", data.get("prompt"));
        intent.putExtra("sessionId", data.get("sessionId"));
        intent.putExtra("permissionId", data.get("permissionId"));
        intent.putExtra("answer", answer);
        intent.putExtra("tag", data.get("tag"));
        intent.putExtra("channel", channel);
        intent.putExtra("title", data.get("title"));
        return PendingIntent.getBroadcast(
            context,
            (target + answer).hashCode(),
            intent,
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );
    }

    static void showWithActions(Context context, Map<String, String> data) {
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        if (nm == null || !nm.areNotificationsEnabled()) return;
        String channel = data.containsKey("channel") ? data.get("channel") : "agentdeck-waiting";
        ensureChannel(context, channel);

        Intent open = new Intent(context, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        open.putExtra(NotifyActionsPlugin.EXTRA_OPEN, data.containsKey("open") ? data.get("open") : "");
        boolean permission = !data.containsKey("terminalId");
        String target = permission ? data.get("permissionId") : data.get("terminalId");
        PendingIntent content = PendingIntent.getActivity(
            context,
            String.valueOf(target).hashCode(),
            open,
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );

        String body = data.containsKey("body") ? data.get("body") : "";
        // Approving from a lock screen is approving without looking: unlock first.
        NotificationCompat.Action yes = new NotificationCompat.Action.Builder(0, permission ? "Allow" : "Yes", answerIntent(context, data, "yes", channel))
            .setAuthenticationRequired(true)
            .build();
        NotificationCompat.Action no = new NotificationCompat.Action.Builder(0, permission ? "Deny" : "No", answerIntent(context, data, "no", channel))
            .setAuthenticationRequired(true)
            .build();

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_stat_agentdeck)
            .setContentTitle(data.get("title"))
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setContentIntent(content)
            .addAction(yes)
            .addAction(no);
        nm.notify(data.get("tag"), 1, builder.build());
    }
}
