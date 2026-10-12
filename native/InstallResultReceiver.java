package com.myexample.webtoapk;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Получает статус установки из PackageInstaller-сессии (см. ApkInstaller). */
public class InstallResultReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        ApkInstaller.onResult(context, intent);
    }
}
