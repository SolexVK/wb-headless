// service/report-names.js — единый источник русских названий отчётов.
// Раньше эта карта дублировалась в reports.js (RU_REPORT), views.js (reportRu) и была
// частично переписана в archivePage.summ(). Теперь одно место без зависимостей.
export const REPORT_RU = {
  podsort: 'Подсорт',
  stock: 'Остатки',
  movement: 'Движение заказов',
  geo: 'География',
  logistics: 'Логистика',
};
export const reportRu = (r) => REPORT_RU[r] || r;
