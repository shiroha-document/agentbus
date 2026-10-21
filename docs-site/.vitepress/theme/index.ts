import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import Steps from "./Steps.vue";
import Shot from "./Shot.vue";
import "./custom.css";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("Steps", Steps);
    app.component("Shot", Shot);
  },
} satisfies Theme;
