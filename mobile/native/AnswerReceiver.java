package com.ninjalama.agentdeck;

import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import androidx.core.app.NotificationCompat;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

/**
 * A tap on Yes / No (terminal question) or Allow / Deny (a chat session's
 * permission request) in a notification: tells the server the answer. The
 * server checks that this very question is still open before it acts. The notification then turns into a
 * short result line.
 */
public class AnswerReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(final Context context, final Intent intent) {
        final PendingResult pending = goAsync();
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    String result = send(context, intent);
                    finish(context, intent, result);
                } finally {
                    pending.finish();
                }
            }
        }, "agentdeck-answer").start();
    }

    private static String send(Context context, Intent intent) {
        SharedPreferences prefs = NotifyActionsPlugin.prefs(context);
        String base = prefs.getString("base", null);
        String token = prefs.getString("token", null);
        if (base == null || token == null) return "Open AgentDeck once, then try again";
        String terminalId = intent.getStringExtra("terminalId");
        String answer = intent.getStringExtra("answer");
        String prompt = intent.getStringExtra("prompt");
        String sessionId = intent.getStringExtra("sessionId");
        String permissionId = intent.getStringExtra("permissionId");
        // A session's permission request, or a terminal's question.
        boolean permission = sessionId != null && permissionId != null;
        if (answer == null || (!permission && (terminalId == null || prompt == null))) return "Could not send the answer";
        boolean yes = "yes".equals(answer);
        HttpURLConnection connection = null;
        try {
            URL url = permission
                ? new URL(base + "/api/sessions/" + URLEncoder.encode(sessionId, "UTF-8") + "/permissions/" + URLEncoder.encode(permissionId, "UTF-8"))
                : new URL(base + "/api/terminals/" + URLEncoder.encode(terminalId, "UTF-8") + "/answer");
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(4000);
            connection.setReadTimeout(5000);
            connection.setRequestMethod("POST");
            connection.setRequestProperty("Authorization", "Bearer " + token);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setDoOutput(true);
            String json = permission
                ? "{\"decision\":\"" + (yes ? "allow" : "deny") + "\"}"
                : "{\"answer\":\"" + answer + "\",\"prompt\":\"" + prompt + "\"}";
            byte[] body = json.getBytes(StandardCharsets.UTF_8);
            try (OutputStream out = connection.getOutputStream()) {
                out.write(body);
            }
            int status = connection.getResponseCode();
            if (permission && status == 204) return yes ? "Allowed" : "Denied";
            if (status == 200) return yes ? "Answered: Yes" : "Answered: No";
            if (status == 409) return "That question is gone — open the app";
            if (status == 401) return "Signed out — open the app";
            return "Could not send (HTTP " + status + ")";
        } catch (Exception e) {
            return "Server not reachable";
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static void finish(Context context, Intent intent, String result) {
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        String tag = intent.getStringExtra("tag");
        if (nm == null || tag == null) return;
        String channel = intent.getStringExtra("channel");
        // Replaces the buttons by the outcome; silent so it does not buzz again.
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, channel == null ? "agentdeck-alerts" : channel)
            .setSmallIcon(R.drawable.ic_stat_agentdeck)
            .setContentTitle(intent.getStringExtra("title"))
            .setContentText(result)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setAutoCancel(true)
            .setTimeoutAfter(8000);
        nm.notify(tag, 1, builder.build());
    }
}
