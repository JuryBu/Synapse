import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export interface ConversationSummary {
  id: string;
  title: string;
  lastMessage: string;
  timestamp: number;
  messageCount: number;
  model: string;
  archived?: boolean;
  tags?: string[];
}

interface ConversationHistoryState {
  conversations: ConversationSummary[];
  selectedId: string | null;
}

const initialState: ConversationHistoryState = {
  conversations: [],
  selectedId: null,
};

export const conversationHistorySlice = createSlice({
  name: 'conversationHistory',
  initialState,
  reducers: {
    addConversation(state, action: PayloadAction<ConversationSummary>) {
      state.conversations.unshift(action.payload);
    },
    removeConversation(state, action: PayloadAction<string>) {
      state.conversations = state.conversations.filter(c => c.id !== action.payload);
    },
    updateConversation(state, action: PayloadAction<Partial<ConversationSummary> & { id: string }>) {
      const idx = state.conversations.findIndex(c => c.id === action.payload.id);
      if (idx >= 0) Object.assign(state.conversations[idx], action.payload);
    },
    setSelectedId(state, action: PayloadAction<string | null>) {
      state.selectedId = action.payload;
    },
    setConversations(state, action: PayloadAction<ConversationSummary[]>) {
      state.conversations = action.payload;
    },
  },
});

export const {
  addConversation, removeConversation, updateConversation,
  setSelectedId, setConversations,
} = conversationHistorySlice.actions;
