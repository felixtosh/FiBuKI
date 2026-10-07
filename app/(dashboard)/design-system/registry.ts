/**
 * Every components/ui example file, grouped and ordered for the
 * design-system page: brand first, then the components used most, then the
 * specialised ones. Inside a group, the most used come first.
 *
 * scripts/check-design-system.mjs fails when a component has no examples file
 * or its examples file is not imported here; lint fails when one is imported
 * but not placed in a group.
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

export interface ComponentGroup {
  id: string;
  title: string;
  intro: string;
  docs: ComponentDoc[];
}

export const componentGroups: ComponentGroup[] = [
  {
    id: "brand",
    title: "Brand",
    intro: "The mascot and logos.",
    docs: [fibukiMascotDoc, telegramLogoDoc],
  },
  {
    id: "actions",
    title: "Actions and labels",
    intro: "What you click and what labels things. The most used components in the app.",
    docs: [buttonDoc, badgeDoc, pillDoc, dropdownMenuDoc],
  },
  {
    id: "forms",
    title: "Forms",
    intro: "Fields and choices.",
    docs: [inputDoc, labelDoc, selectDoc, checkboxDoc, switchDoc, searchInputDoc, calendarDoc],
  },
  {
    id: "layout",
    title: "Layout",
    intro: "Boxes, dividers and sections that hold content.",
    docs: [cardDoc, scrollAreaDoc, settingsPageHeaderDoc, separatorDoc, tabsDoc, collapsibleDoc],
  },
  {
    id: "feedback",
    title: "Feedback",
    intro: "Telling the user what happened or what is loading.",
    docs: [alertDoc, skeletonDoc, progressDoc, tableEmptyStateDoc, summaryToastDoc],
  },
  {
    id: "overlays",
    title: "Overlays",
    intro: "Things that open on top of the page.",
    docs: [tooltipDoc, dialogDoc, popoverDoc, alertDialogDoc, sheetDoc, infoPopoverDoc],
  },
  {
    id: "lists",
    title: "List pages",
    intro: "The parts every list page (Files, Transactions, Partners) is built from.",
    docs: [dataTableDoc, tableDoc, searchButtonDoc, overflowFilterRowDoc, choiceFilterDoc, dateRangeFilterDoc, progressCounterDoc],
  },
  {
    id: "detail",
    title: "Detail panels",
    intro: "The panel that opens on the right when a row is picked.",
    docs: [detailPanelPrimitivesDoc, detailPanelLayoutDoc, showMoreButtonDoc],
  },
  {
    id: "connect",
    title: "Connecting Files and Transactions",
    intro: "Specialised: the connect flow and its match display.",
    docs: [amountMatchDisplayDoc, connectButtonDoc, connectResultRowDoc, contentOverlayDoc],
  },
];

export const componentDocs: ComponentDoc[] = componentGroups.flatMap((group) => group.docs);
