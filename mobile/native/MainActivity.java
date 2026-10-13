package com.ninjalama.agentdeck;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /** True while the app is in front (AgentDeckMessagingService skips its own notification then). */
    static volatile boolean visible = false;

    @Override
    public void onStart() {
        super.onStart();
        visible = true;
    }

    @Override
    public void onStop() {
        visible = false;
        super.onStop();
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // App-local plugins must be registered before the bridge starts.
        registerPlugin(FileDownloadPlugin.class);
        registerPlugin(ApkInstallPlugin.class);
        registerPlugin(NotifyActionsPlugin.class);
        registerPlugin(ShareTargetPlugin.class);
        registerPlugin(MediaInputPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
