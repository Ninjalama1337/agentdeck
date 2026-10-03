package com.ninjalama.agentdeck;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Bridge for notifications with Yes/No buttons.
 *
 * - setCredentials: the web app hands over the server address and device
 *   token, so AnswerReceiver can call the server while the app is closed.
 * - `open` event: a tap on a notification this app drew itself
 *   (AgentDeckMessagingService) carries the deep link as an intent extra.
 */
@CapacitorPlugin(name = "NotifyActions")
public class NotifyActionsPlugin extends Plugin {

    static final String PREFS = "agentdeck_notify";
    static final String EXTRA_OPEN = "agentdeck_open";

    static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    @Override
    public void load() {
        if (getActivity() != null) {
            deliverOpen(getActivity().getIntent());
        }
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        deliverOpen(intent);
    }

    private void deliverOpen(Intent intent) {
        if (intent == null) return;
        String open = intent.getStringExtra(EXTRA_OPEN);
        if (open == null || open.isEmpty()) return;
        intent.removeExtra(EXTRA_OPEN);
        JSObject event = new JSObject();
        event.put("open", open);
        // Retained: on a cold start the web app registers its listener later.
        notifyListeners("open", event, true);
    }

    @PluginMethod
    public void setCredentials(PluginCall call) {
        String base = call.getString("base");
        String token = call.getString("token");
        SharedPreferences.Editor edit = prefs(getContext()).edit();
        if (base == null || base.isEmpty() || token == null || token.isEmpty()) {
            edit.clear();
        } else {
            edit.putString("base", base.replaceAll("/+$", "")).putString("token", token);
        }
        edit.apply();
        call.resolve();
    }
}
