export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      daily_stats: {
        Row: {
          blocked: boolean
          loss_usd: number
          pnl_usd: number
          trade_date: string
          trades_count: number
          user_id: string
        }
        Insert: {
          blocked?: boolean
          loss_usd?: number
          pnl_usd?: number
          trade_date: string
          trades_count?: number
          user_id: string
        }
        Update: {
          blocked?: boolean
          loss_usd?: number
          pnl_usd?: number
          trade_date?: string
          trades_count?: number
          user_id?: string
        }
        Relationships: []
      }
      journal_trades: {
        Row: {
          bias: string
          closed_at: string | null
          entry: number
          exit: number | null
          id: string
          lot_size: number
          notes: string | null
          opened_at: string
          pnl_usd: number | null
          r_multiple: number | null
          result: string | null
          setup_id: string | null
          stop_loss: number
          user_id: string
        }
        Insert: {
          bias: string
          closed_at?: string | null
          entry: number
          exit?: number | null
          id?: string
          lot_size: number
          notes?: string | null
          opened_at?: string
          pnl_usd?: number | null
          r_multiple?: number | null
          result?: string | null
          setup_id?: string | null
          stop_loss: number
          user_id: string
        }
        Update: {
          bias?: string
          closed_at?: string | null
          entry?: number
          exit?: number | null
          id?: string
          lot_size?: number
          notes?: string | null
          opened_at?: string
          pnl_usd?: number | null
          r_multiple?: number | null
          result?: string | null
          setup_id?: string | null
          stop_loss?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "journal_trades_setup_id_fkey"
            columns: ["setup_id"]
            isOneToOne: false
            referencedRelation: "setups"
            referencedColumns: ["id"]
          },
        ]
      }
      mt5_ea_tokens: {
        Row: {
          created_at: string
          id: string
          label: string | null
          last_used_at: string | null
          token: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          label?: string | null
          last_used_at?: string | null
          token: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          label?: string | null
          last_used_at?: string | null
          token?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      mt5_signals: {
        Row: {
          bias: string
          break_even_at_r: number | null
          closed_at: string | null
          confidence: string | null
          created_at: string
          engine: string
          entry: number
          error_message: string | null
          exit_price: number | null
          expires_at: string
          fill_price: number | null
          filled_at: string | null
          id: string
          lot_size: number | null
          mt5_ticket: number | null
          pnl_usd: number | null
          r_multiple: number | null
          reasoning: Json
          risk_usd: number | null
          score: number | null
          status: string
          stop_loss: number
          symbol: string
          time_stop_minutes: number | null
          tp1: number
          tp2: number | null
          tp3: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          bias: string
          break_even_at_r?: number | null
          closed_at?: string | null
          confidence?: string | null
          created_at?: string
          engine: string
          entry: number
          error_message?: string | null
          exit_price?: number | null
          expires_at?: string
          fill_price?: number | null
          filled_at?: string | null
          id?: string
          lot_size?: number | null
          mt5_ticket?: number | null
          pnl_usd?: number | null
          r_multiple?: number | null
          reasoning?: Json
          risk_usd?: number | null
          score?: number | null
          status?: string
          stop_loss: number
          symbol?: string
          time_stop_minutes?: number | null
          tp1: number
          tp2?: number | null
          tp3?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          bias?: string
          break_even_at_r?: number | null
          closed_at?: string | null
          confidence?: string | null
          created_at?: string
          engine?: string
          entry?: number
          error_message?: string | null
          exit_price?: number | null
          expires_at?: string
          fill_price?: number | null
          filled_at?: string | null
          id?: string
          lot_size?: number | null
          mt5_ticket?: number | null
          pnl_usd?: number | null
          r_multiple?: number | null
          reasoning?: Json
          risk_usd?: number | null
          score?: number | null
          status?: string
          stop_loss?: number
          symbol?: string
          time_stop_minutes?: number | null
          tp1?: number
          tp2?: number | null
          tp3?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      setups: {
        Row: {
          bias: string
          confidence: string
          created_at: string
          entry: number
          id: string
          lot_size: number
          reasoning: Json
          risk_usd: number
          status: string
          stop_loss: number
          symbol: string
          telegram_sent_at: string | null
          tp1: number
          tp2: number
          tp3: number | null
          user_id: string
        }
        Insert: {
          bias: string
          confidence: string
          created_at?: string
          entry: number
          id?: string
          lot_size: number
          reasoning?: Json
          risk_usd: number
          status?: string
          stop_loss: number
          symbol?: string
          telegram_sent_at?: string | null
          tp1: number
          tp2: number
          tp3?: number | null
          user_id: string
        }
        Update: {
          bias?: string
          confidence?: string
          created_at?: string
          entry?: number
          id?: string
          lot_size?: number
          reasoning?: Json
          risk_usd?: number
          status?: string
          stop_loss?: number
          symbol?: string
          telegram_sent_at?: string | null
          tp1?: number
          tp2?: number
          tp3?: number | null
          user_id?: string
        }
        Relationships: []
      }
      signal_events: {
        Row: {
          bias: string
          bucket_hour: string
          closed_at: string | null
          confidence: string
          created_at: string
          engine: string
          entry: number
          entry_time: string | null
          exit_price: number | null
          id: string
          outcome: string | null
          r_multiple: number | null
          reasoning: Json
          score: number
          stop_loss: number
          telegram_error: string | null
          telegram_sent: boolean
          tp1: number
          tp2: number
          tp3: number | null
          user_id: string
        }
        Insert: {
          bias: string
          bucket_hour: string
          closed_at?: string | null
          confidence: string
          created_at?: string
          engine: string
          entry: number
          entry_time?: string | null
          exit_price?: number | null
          id?: string
          outcome?: string | null
          r_multiple?: number | null
          reasoning?: Json
          score: number
          stop_loss: number
          telegram_error?: string | null
          telegram_sent?: boolean
          tp1: number
          tp2: number
          tp3?: number | null
          user_id: string
        }
        Update: {
          bias?: string
          bucket_hour?: string
          closed_at?: string | null
          confidence?: string
          created_at?: string
          engine?: string
          entry?: number
          entry_time?: string | null
          exit_price?: number | null
          id?: string
          outcome?: string | null
          r_multiple?: number | null
          reasoning?: Json
          score?: number
          stop_loss?: number
          telegram_error?: string | null
          telegram_sent?: boolean
          tp1?: number
          tp2?: number
          tp3?: number | null
          user_id?: string
        }
        Relationships: []
      }
      user_config: {
        Row: {
          auto_alert_high_confidence: boolean
          balance: number
          created_at: string
          max_daily_loss_pct: number
          max_trades_per_day: number
          risk_per_trade: number
          telegram_chat_id: string | null
          telegram_enabled: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          auto_alert_high_confidence?: boolean
          balance?: number
          created_at?: string
          max_daily_loss_pct?: number
          max_trades_per_day?: number
          risk_per_trade?: number
          telegram_chat_id?: string | null
          telegram_enabled?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          auto_alert_high_confidence?: boolean
          balance?: number
          created_at?: string
          max_daily_loss_pct?: number
          max_trades_per_day?: number
          risk_per_trade?: number
          telegram_chat_id?: string | null
          telegram_enabled?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
