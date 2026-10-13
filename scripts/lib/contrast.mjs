// Measures WCAG contrast ratios for a list of CSS selectors, resolved inside
// the page so stylesheet-driven colors are observed as rendered.
export async function measureContrastRatios(page, selectors) {
  return page.evaluate((requestedSelectors) => {
    const rgb = (value) => {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("Canvas color conversion is unavailable.");
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
    };
    const luminance = (color) => color
      .map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.04045
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4;
      })
      .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
    const backgroundFor = (node) => {
      let current = node;
      while (current) {
        const background = getComputedStyle(current).backgroundColor;
        if (background !== "transparent" && background !== "rgba(0, 0, 0, 0)") return background;
        current = current.parentElement;
      }
      return "rgb(255,255,255)";
    };
    return Object.fromEntries(requestedSelectors.map((selector) => {
      const node = document.querySelector(selector);
      if (!node) throw new Error(`Missing contrast sample ${selector}`);
      const foreground = luminance(rgb(getComputedStyle(node).color));
      const background = luminance(rgb(backgroundFor(node)));
      return [selector, (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)];
    }));
  }, selectors);
}
