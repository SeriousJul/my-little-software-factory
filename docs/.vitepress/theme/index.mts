import DefaultTheme from "vitepress/theme";
import "./custom.css";
import { setupLightbox } from "./lightbox";

export default {
	...DefaultTheme,
	enhanceApp(ctx: Parameters<typeof DefaultTheme.enhanceApp>[0]) {
		DefaultTheme.enhanceApp(ctx);
		setupLightbox();
	},
};
