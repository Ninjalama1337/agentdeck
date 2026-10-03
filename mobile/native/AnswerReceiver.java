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
 * A tap on Yes / No in a notification: tells the server to answer the
 * terminal's question. The server checks that the terminal still shows that
 * very question before it presses a key. The notification then turns into a
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
        if (terminalId == null || answer == null || prompt == null) return "Could not send the answer";
        HttpURLConnection connection = null;
        try {
            URL url = new URL(base + "/api/terminals/" + URLEncoder.encode(terminalId, "UTF-8") + "/answer");
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(4000);
            connection.setReadTimeout(5000);
            connection.setRequestMethod("POST");
            connection.setRequestProperty("Authorization", "Bearer " + token);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setDoOutput(true);
            byte[] body = ("{\"answer\":\"" + answer + "\",\"prompt\":\"" + prompt + "\"}").getBytes(StandardCharsets.UTF_8);
            try (OutputStream out = connection.getOutputStream()) {
                out.write(body);
            }
            int status = connection.getResponseCode();
            if (status == 200) return "yes".equals(answer) ? "Answered: Yes" : "Answered: No";
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
