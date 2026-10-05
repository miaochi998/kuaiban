package com.kuaiban.app

import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // ── 别让内容钻到状态栏底下 ──────────────────────────────────
    //
    // 真机实测：顶部标题栏被安卓的时间/信号/电池图标压住，
    // 连"设置""钉住"都点不准，左侧的日期星期也被遮掉一部分。
    //
    // 原因有两个，缺一不可地要一起解决：
    //   ① 这里显式调了 enableEdgeToEdge()；
    //   ② **Android 15（targetSdk 35+）本来就强制边到边** ——
    //      所以"去掉 ①"并不够，必须真正把系统栏高度处理掉。
    //
    // 做法：把系统栏高度作为内边距加回内容视图，内容就落在状态栏下面。
    // 用 android.R.id.content（而不是 decorView）是标准做法，避免重复内边距。
    ViewCompat.setOnApplyWindowInsetsListener(findViewById(android.R.id.content)) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      insets
    }
  }
}
