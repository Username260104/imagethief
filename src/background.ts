type SourceImageCandidate = {
  kind: "html-img" | "css-background";
  pageUrl: string;
  imageUrl: string;
  currentSrc?: string;
  src?: string;
  elementRect: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
  naturalWidth?: number;
  naturalHeight?: number;
  css?: {
    backgroundSize?: string;
    backgroundPosition?: string;
    backgroundRepeat?: string;
  };
};

type CandidateSelectedMessage = {
  type: "IMAGE_THIEF_CANDIDATE_SELECTED";
  candidate: SourceImageCandidate;
};

type WorkbenchSession = {
  id: string;
  createdAt: number;
  candidate: SourceImageCandidate;
};

const SESSION_STORAGE_PREFIX = "imagethief:session:";

chrome.action.onClicked.addListener((tab) => {
  void activateSelectionMode(tab);
});

chrome.commands.onCommand.addListener((_command, tab) => {
  if (tab) {
    void activateSelectionMode(tab);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isCandidateSelectedMessage(message)) {
    return false;
  }

  void openWorkbench(message.candidate, sender.tab?.id)
    .then(() => sendResponse({ ok: true }))
    .catch((error: unknown) => {
      console.debug("ImageThief failed to open workbench", error);
      sendResponse({ ok: false });
    });

  return true;
});

async function activateSelectionMode(tab: chrome.tabs.Tab): Promise<void> {
  if (typeof tab.id !== "number") {
    return;
  }

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["content.js"]
  });

  await chrome.tabs.sendMessage(tab.id, { type: "IMAGE_THIEF_START_SELECTION" });
}

async function openWorkbench(candidate: SourceImageCandidate, openerTabId?: number): Promise<void> {
  const id = crypto.randomUUID();
  const session: WorkbenchSession = {
    id,
    createdAt: Date.now(),
    candidate
  };

  await chrome.storage.session.set({
    [`${SESSION_STORAGE_PREFIX}${id}`]: session
  });

  const url = chrome.runtime.getURL(`workbench.html?sessionId=${encodeURIComponent(id)}`);
  const createProperties: { url: string; active: boolean; openerTabId?: number } = {
    url,
    active: true
  };
  if (typeof openerTabId === "number") {
    createProperties.openerTabId = openerTabId;
  }

  await chrome.tabs.create(createProperties);
}

function isCandidateSelectedMessage(message: unknown): message is CandidateSelectedMessage {
  if (!message || typeof message !== "object") {
    return false;
  }

  const typed = message as CandidateSelectedMessage;
  return typed.type === "IMAGE_THIEF_CANDIDATE_SELECTED" && isCandidate(typed.candidate);
}

function isCandidate(candidate: unknown): candidate is SourceImageCandidate {
  if (!candidate || typeof candidate !== "object") {
    return false;
  }

  const typed = candidate as SourceImageCandidate;
  return (
    (typed.kind === "html-img" || typed.kind === "css-background") &&
    typeof typed.pageUrl === "string" &&
    typeof typed.imageUrl === "string" &&
    Boolean(typed.imageUrl)
  );
}
