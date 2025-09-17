export function setupExportPDFButton(condensedCanvases) {
  const exportBtn = document.getElementById('exportPDFBtn');
  const progressContainer = document.getElementById('exportProgressContainer');
  const progressBar = document.getElementById('exportProgressBar');

  if (!exportBtn) return;

  exportBtn.addEventListener('click', async () => {
    if (!condensedCanvases || condensedCanvases.length === 0) {
      alert('A supported tab PDF file is not currently opened.');
      return;
    }

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ unit: 'px', format: 'a4', orientation: 'portrait' });

    const A4_WIDTH = pdf.internal.pageSize.getWidth();
    const A4_HEIGHT = pdf.internal.pageSize.getHeight();
    let cursorY = 0;

    // Show progress
    if (progressContainer) progressContainer.style.display = 'block';
    if (progressBar) {
      progressBar.style.width = '0%';
      progressBar.textContent = '0%';
    }

    for (let i = 0; i < condensedCanvases.length; i++) {
      const canvas = condensedCanvases[i];
      const scale = Math.min(A4_WIDTH / canvas.width, A4_HEIGHT / canvas.height);
      const canvasWidth = canvas.width * scale;
      const canvasHeight = canvas.height * scale;

      if (cursorY + canvasHeight > A4_HEIGHT) {
        pdf.addPage();
        cursorY = 0;
      }

      const imgData = canvas.toDataURL('image/png');
      pdf.addImage(imgData, 'PNG', (A4_WIDTH - canvasWidth) / 2, cursorY, canvasWidth, canvasHeight);
      cursorY += canvasHeight;

      // Update progress
      if (progressBar) {
        const pct = Math.round(((i + 1) / condensedCanvases.length) * 100);
        progressBar.style.width = pct + '%';
        progressBar.textContent = pct + '%';
      }

      // Yield to the browser to prevent freezing
      await new Promise(requestAnimationFrame);
    }

    pdf.save('MajesticTab.pdf');

    // Hide progress
    if (progressContainer) progressContainer.style.display = 'none';
  });
}
