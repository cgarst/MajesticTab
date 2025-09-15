# MajesticTab

MajesticTab transforms PDF guitar tablature into an immersive, distraction-free experience for tablets and computers — helping guitarists stay focused and practice smarter. It is specifically built to more efficiently display information from Guitar Pro PDF files which where exported in multitrack tab-only view.

This tool was made to reduce the number of pages that guitarists need to flip through while using multitrack tab. This enables tabs with multiple rhythm and lead tracks to be optimized to consume a fraction of the pages.

➡️ [Try MajesticTab here](https://cgarst.github.io/MajesticTab/).

---

## ✨ Features

- **PDF Tab Optimization**
  - Finds staves that contain notes
  - Discards empty staves
  - Re-draws staff groupings based on what tracks are actively playing
  - Cleans margins and trims whitespace
  - Removes A4 size limitations to maximize the vertical space of your screen

- **Viewing Modes**
  - **Page Mode**: View 1 or 2 pages at a time
  - **Continuous Mode**: Infinite scroll

- **UI Options**
  - Mouse, touch, or keyboard navigation
  - Compatible with most Bluetooth page turner pedals
  - Dark mode
  - Advance one page vs. two pages at a time in page mode
  - Responsive layout for desktop and mobile

- **Export**
  - Save optimized tab as a new, space-saving A4 printable PDF

- **Integrations**
  - Import PDFs directly from Google Drive (coming soon)

---

## 🚀 Getting Started

### Prerequisites
- A modern web browser (Chrome, Edge, Firefox, Safari)
- (Optional) A Google Drive account if you want to import files from Drive

### Run via GitHub Pages

The application is entire client based. No files are transmitted to the developer or GitHub. It is hosted through GitHub pages at: [https://cgarst.github.io/MajesticTab/](https://cgarst.github.io/MajesticTab/)

### Run Locally

Clone this repo:
```bash
git clone https://github.com/cgarst/MajesticTab.git
cd MajesticTab
python -m http.server
````

Open `http://localhost:8080` in your browser.

---

## 📖 Usage

1. **Load a PDF**

   * Click **Choose File** and select your tab PDF
   * Or use the **Google Drive** button to import from Drive (coming soon)

2. **Choose a Viewing Mode**

   * Page Mode: traditional page-by-page navigation. Automatically switches to two pages if the device is wider than tall.
   * Continuous Mode: scroll vertically with a progress percentage indicator

3. **Navigation**

   * In Page Mode, use Prev/Next buttons, tap/click, arrow keys, space/enter keys, or page up/down keys.
   * In Continuous Mode, scroll, or use the buttons as page mode.

4. **Export**

   * When processing is complete, the **Export PDF** button appears to download the condensed PDF

5. **Customize**

   * Toggle **Dark Mode** in the menu to invert typical black-on-white PDF content
   * Toggle **Always Advance One Page** for finer control in page mode
   * Toggle **View Original PDF** to disable the optimization features

---

## 🎸 Acquiring Guitar Pro PDF Files

### Exporting a Multitrack Tab-Only PDF from Guitar Pro

MajesticTab works best with multitrack tab-only PDFs exported from Guitar Pro. Tab transcribers will often provide PDFs in this format. MajesticTab was developed primarily using [Evan Bradley](https://www.youtube.com/channel/UCb7scw9S8yGgmCUz9wAuukg)'s tabs offered through his YouTube video descriptions. Using Guitar Pro, you can convert widely available Guitar Pro tabs into the multitrack PDFs suitable for MajesticTab.

#### 1. Open Your Tab

* Launch **Guitar Pro** and open the tab you want to export.

#### 2. Configure the Score Display

1. Go to the **View** menu → **Multitrack**.
2. Double click each guitar track to open it's track settings.
3. Make sure **Standard notation** is **disabled** and **Tablature notation** is **enabled**.
4. Hide non-guitar tracks from view using the **eye** toggle in the track list.

#### 3. Export to PDF

1. Select **File > Export > PDF**.

---

## 🛠 Development

### File Structure

* `main.js` → Handles UI, navigation, modes
* `pdfProcessor/` → Core logic for PDF rendering, staff detection, and trimming
* `exportPdf.js` → Export to PDF
* `googleDrive.js` → Google Drive integration

### Install Dependencies

The project is browser-only. External dependencies are loaded via CDN, so no build step is required.

---

## 🤝 Contributing

Contributions are welcome!
To contribute:

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/awesome-feature`)
3. Commit changes (`git commit -m 'Add awesome feature'`)
4. Push to branch (`git push origin feature/awesome-feature`)
5. Open a Pull Request

Please include screenshots or descriptions for UI changes.

---

## 📜 License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

---

## 🙌 Acknowledgments

* [PDF.js](https://mozilla.github.io/pdf.js/) for PDF rendering
* [Bootstrap](https://getbootstrap.com/) for UI components
* [jsPDF](https://github.com/parallax/jsPDF) for export functionality
