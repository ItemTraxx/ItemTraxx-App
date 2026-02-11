import { onMounted, onUnmounted, ref, type Ref } from "vue";

type RenderOptions = {
  sitekey: string;
  callback?: (token: string) => void;
  "error-callback"?: () => void;
  "expired-callback"?: () => void;
  theme?: "auto" | "light" | "dark";
};

type TurnstileApi = {
  render: (container: string | HTMLElement, options: RenderOptions) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId?: string) => void;
};

export const useTurnstile = (siteKey?: string) => {
  const containerRef = ref<HTMLElement | null>(null);
  const token = ref("");
  const isReady = ref(false);
  let widgetId: string | null = null;
  let bootTimer: number | null = null;

  const clearBootTimer = () => {
    if (bootTimer) {
      window.clearInterval(bootTimer);
      bootTimer = null;
    }
  };

  const mountWidget = () => {
    if (!siteKey || !containerRef.value || widgetId) {
      return;
    }

    const api = window.turnstile as TurnstileApi | undefined;
    if (!api) {
      return;
    }

    widgetId = api.render(containerRef.value, {
      sitekey: siteKey,
      theme: "auto",
      callback: (nextToken) => {
        token.value = nextToken;
      },
      "expired-callback": () => {
        token.value = "";
      },
      "error-callback": () => {
        token.value = "";
      },
    });
    isReady.value = true;
  };

  const reset = () => {
    if (!widgetId || !window.turnstile) {
      token.value = "";
      return;
    }
    window.turnstile.reset(widgetId);
    token.value = "";
  };

  onMounted(() => {
    if (!siteKey) {
      return;
    }
    mountWidget();
    if (!widgetId) {
      bootTimer = window.setInterval(() => {
        mountWidget();
        if (widgetId) {
          clearBootTimer();
        }
      }, 250);
    }
  });

  onUnmounted(() => {
    clearBootTimer();
    if (widgetId && window.turnstile) {
      window.turnstile.remove(widgetId);
    }
    widgetId = null;
  });

  return {
    containerRef: containerRef as Ref<HTMLElement | null>,
    token,
    isReady,
    reset,
  };
};
