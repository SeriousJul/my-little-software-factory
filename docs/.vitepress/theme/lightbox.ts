// A minimal image lightbox for the screenshots. A screenshot opens full-bleed
// so it reads at the display's size instead of the column's. The overlay
// closes on Escape, on the backdrop, or on the close button. It binds by
// event delegation on the document, so it survives the site's client-side
// page navigation without re-binding on each route change.

const SELECTOR = ".vp-doc img";

export function setupLightbox(): void {
	// The overlay binds to the DOM, which exists only in the browser. The
	// build renders pages in Node, where this hook also runs.
	if (typeof document === "undefined") {
		return;
	}
	document.addEventListener("click", onClick);
}

function onClick(event: MouseEvent): void {
	const target = event.target;
	if (!(target instanceof HTMLImageElement)) {
		return;
	}
	if (target.closest(SELECTOR) === null) {
		return;
	}
	const src = target.currentSrc || target.src;
	if (src === "") {
		return;
	}
	open(target.alt, src);
}

function open(alt: string, src: string): void {
	const overlay = ensureOverlay();
	const img = overlay.querySelector<HTMLImageElement>(".site-lightbox-img");
	if (img !== null) {
		img.src = src;
		img.alt = alt;
	}
	overlay.classList.add("is-open");
	document.body.classList.add("site-lightbox-open");
}

function close(): void {
	const overlay = document.querySelector<HTMLElement>(".site-lightbox");
	overlay?.classList.remove("is-open");
	document.body.classList.remove("site-lightbox-open");
}

function ensureOverlay(): HTMLElement {
	const existing = document.querySelector<HTMLElement>(".site-lightbox");
	if (existing !== null) {
		return existing;
	}
	const overlay = document.createElement("div");
	overlay.className = "site-lightbox";
	overlay.setAttribute("role", "dialog");
	overlay.setAttribute("aria-modal", "true");

	const img = document.createElement("img");
	img.className = "site-lightbox-img";

	const button = document.createElement("button");
	button.className = "site-lightbox-close";
	button.setAttribute("aria-label", "Close image");
	button.textContent = "\u00d7";

	overlay.append(img, button);
	document.body.appendChild(overlay);

	overlay.addEventListener("click", (event) => {
		if (event.target === overlay) {
			close();
		}
	});
	button.addEventListener("click", close);
	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			close();
		}
	});
	return overlay;
}
