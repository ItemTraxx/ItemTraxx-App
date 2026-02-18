import { createApp } from "vue";
import "./style.css";
import App from "./App.vue";
import router from "./router";
import { initAuthListener, refreshAuthFromSession } from "./services/authService";
import { clearAuthState, getAuthState } from "./store/authState";
import { TimeoutError, withTimeout } from "./services/asyncUtils";

const bootstrap = async () => {
  try {
    await withTimeout(
      refreshAuthFromSession(),
      6000,
      "Authentication initialization timed out."
    );
  } catch (error) {
    if (error instanceof TimeoutError) {
      console.error("Auth initialization timeout:", error.message);
    } else {
      console.error("Auth initialization failed:", error);
    }
  } finally {
    if (!getAuthState().isInitialized) {
      clearAuthState(true);
    }
  }

  initAuthListener();

  const app = createApp(App);
  app.use(router);
  app.mount("#app");
};

bootstrap();
