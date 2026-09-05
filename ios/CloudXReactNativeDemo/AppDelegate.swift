import UIKit
import React
import React_RCTAppDelegate
import AppTrackingTransparency
import AdSupport

@main
class AppDelegate: RCTAppDelegate {

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    /*
     * Force test mode. This is a demo app running against shared demo
     * placements, so it must serve test creatives rather than burn real fill
     * against demo traffic. Remove both defaults in a production integration.
     */
    UserDefaults.standard.set(true, forKey: "CLXCore_Internal_ForceTestMode")
    UserDefaults.standard.set(true, forKey: "CLXMetaTestModeEnabled")

    self.moduleName = "CloudXReactNativeDemo"
    self.initialProps = [:]

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }

  override func applicationDidBecomeActive(_ application: UIApplication) {
    requestTrackingPermission()
  }

  private func requestTrackingPermission() {
    if #available(iOS 14, *) {
      let status = ATTrackingManager.trackingAuthorizationStatus
      if status == .notDetermined {
        ATTrackingManager.requestTrackingAuthorization { _ in }
      }
    }
  }
}
