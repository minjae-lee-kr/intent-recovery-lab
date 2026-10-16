(() => {
  const key = 'intent-recovery.report.language';
  let lang = navigator.language.toLowerCase().startsWith('ko') ? 'ko' : 'en';
  try {
    const saved = localStorage.getItem(key);
    if (saved === 'ko' || saved === 'en') lang = saved;
  } catch {}
  const apply = () => {
    document.documentElement.lang = lang;
    document.title =
      lang === 'ko' ? 'Intent / Recovery — 실험 근거' : 'Intent / Recovery — Experiment evidence';
    document
      .querySelectorAll('[data-set-lang]')
      .forEach((button) =>
        button.setAttribute('aria-pressed', String(button.dataset.setLang === lang)),
      );
  };
  document.querySelectorAll('[data-set-lang]').forEach((button) =>
    button.addEventListener('click', () => {
      lang = button.dataset.setLang;
      try {
        localStorage.setItem(key, lang);
      } catch {}
      apply();
    }),
  );
  apply();
})();
