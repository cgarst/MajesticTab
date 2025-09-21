// navigationConfig.js

/**
 * Class to manage navigation configuration and state
 */
export class NavigationConfig {
    constructor(config) {
        this.config = config;
    }

    get isGPFile() {
        return Boolean(this.config.gpState?.canvases[0]);
    }

    get isPageMode() {
        return this.config.pageModeChecked || this.config.pageModeRadio?.checked;
    }

    get output() {
        return this.config.output;
    }

    get currentPageIndex() {
        return this.config.currentPageIndex || this.config.getCurrentPageIndex?.();
    }

    get pages() {
        return this.config.pages || this.config.getPages?.();
    }

    get step() {
        return this.config.step || this.config.getPageStep?.() || 1;
    }

    setCurrentPageIndex(index) {
        if (this.config.setCurrentPageIndex) {
            this.config.setCurrentPageIndex(index);
        }
    }

    renderGPPage() {
        if (this.isGPFile) {
            this.config.renderGPPage(
                this.output, 
                this.isPageMode, 
                this.config.continuousModeRadio
            );
        }
    }
}