/**
 * Every components/ui example file, in one list. The design-system page and
 * tests-components/design-system-examples.test.tsx both read it, and
 * scripts/check-design-system.mjs fails when a component has no examples file
 * or its examples file is missing here.
 */

import type { ComponentDoc } from "@/lib/design-system/types";
import alertDialogDoc from "@/components/ui/alert-dialog.examples";
import alertDoc from "@/components/ui/alert.examples";
import amountMatchDisplayDoc from "@/components/ui/amount-match-display.examples";
import badgeDoc from "@/components/ui/badge.examples";
import buttonDoc from "@/components/ui/button.examples";
import calendarDoc from "@/components/ui/calendar.examples";
import cardDoc from "@/components/ui/card.examples";
import checkboxDoc from "@/components/ui/checkbox.examples";
import choiceFilterDoc from "@/components/ui/choice-filter.examples";
import collapsibleDoc from "@/components/ui/collapsible.examples";
import connectButtonDoc from "@/components/ui/connect-button.examples";
import connectResultRowDoc from "@/components/ui/connect-result-row.examples";
import contentOverlayDoc from "@/components/ui/content-overlay.examples";
import dataTableDoc from "@/components/ui/data-table/data-table.examples";
import dateRangeFilterDoc from "@/components/ui/date-range-filter.examples";
import detailPanelLayoutDoc from "@/components/ui/detail-panel-layout.examples";
import detailPanelPrimitivesDoc from "@/components/ui/detail-panel-primitives.examples";
import dialogDoc from "@/components/ui/dialog.examples";
import dropdownMenuDoc from "@/components/ui/dropdown-menu.examples";
import fibukiMascotDoc from "@/components/ui/fibuki-mascot.examples";
import infoPopoverDoc from "@/components/ui/info-popover.examples";
import inputDoc from "@/components/ui/input.examples";
import labelDoc from "@/components/ui/label.examples";
import overflowFilterRowDoc from "@/components/ui/overflow-filter-row.examples";
import pillDoc from "@/components/ui/pill.examples";
import popoverDoc from "@/components/ui/popover.examples";
import progressCounterDoc from "@/components/ui/progress-counter.examples";
import progressDoc from "@/components/ui/progress.examples";
import scrollAreaDoc from "@/components/ui/scroll-area.examples";
import searchButtonDoc from "@/components/ui/search-button.examples";
import searchInputDoc from "@/components/ui/search-input.examples";
import selectDoc from "@/components/ui/select.examples";
import separatorDoc from "@/components/ui/separator.examples";
import settingsPageHeaderDoc from "@/components/ui/settings-page-header.examples";
import sheetDoc from "@/components/ui/sheet.examples";
import showMoreButtonDoc from "@/components/ui/show-more-button.examples";
import skeletonDoc from "@/components/ui/skeleton.examples";
import summaryToastDoc from "@/components/ui/summary-toast.examples";
import switchDoc from "@/components/ui/switch.examples";
import tableEmptyStateDoc from "@/components/ui/table-empty-state.examples";
import tableDoc from "@/components/ui/table.examples";
import tabsDoc from "@/components/ui/tabs.examples";
import telegramLogoDoc from "@/components/ui/telegram-logo.examples";
import tooltipDoc from "@/components/ui/tooltip.examples";

export const componentDocs: ComponentDoc[] = [
  alertDialogDoc,
  alertDoc,
  amountMatchDisplayDoc,
  badgeDoc,
  buttonDoc,
  calendarDoc,
  cardDoc,
  checkboxDoc,
  choiceFilterDoc,
  collapsibleDoc,
  connectButtonDoc,
  connectResultRowDoc,
  contentOverlayDoc,
  dataTableDoc,
  dateRangeFilterDoc,
  detailPanelLayoutDoc,
  detailPanelPrimitivesDoc,
  dialogDoc,
  dropdownMenuDoc,
  fibukiMascotDoc,
  infoPopoverDoc,
  inputDoc,
  labelDoc,
  overflowFilterRowDoc,
  pillDoc,
  popoverDoc,
  progressCounterDoc,
  progressDoc,
  scrollAreaDoc,
  searchButtonDoc,
  searchInputDoc,
  selectDoc,
  separatorDoc,
  settingsPageHeaderDoc,
  sheetDoc,
  showMoreButtonDoc,
  skeletonDoc,
  summaryToastDoc,
  switchDoc,
  tableEmptyStateDoc,
  tableDoc,
  tabsDoc,
  telegramLogoDoc,
  tooltipDoc,
];
