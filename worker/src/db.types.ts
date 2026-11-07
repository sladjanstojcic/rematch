export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      catchup_cycles: {
        Row: {
          closed_at: string | null
          created_at: string
          id: string
          ordinal: number
          prompt_hash: string
          subscriber_id: string
        }
        Insert: {
          closed_at?: string | null
          created_at?: string
          id?: string
          ordinal?: never
          prompt_hash: string
          subscriber_id: string
        }
        Update: {
          closed_at?: string | null
          created_at?: string
          id?: string
          ordinal?: never
          prompt_hash?: string
          subscriber_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "catchup_cycles_subscriber_id_fkey"
            columns: ["subscriber_id"]
            isOneToOne: false
            referencedRelation: "subscribers"
            referencedColumns: ["id"]
          },
        ]
      }
      catchup_members: {
        Row: {
          created_at: string
          cycle_id: string
          job_id: string
        }
        Insert: {
          created_at?: string
          cycle_id: string
          job_id: string
        }
        Update: {
          created_at?: string
          cycle_id?: string
          job_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "catchup_members_cycle_id_fkey"
            columns: ["cycle_id"]
            isOneToOne: false
            referencedRelation: "catchup_cycles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "catchup_members_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      companies: {
        Row: {
          active: boolean
          ats: string
          created_at: string
          discovered_via: string
          id: string
          last_remote_job_at: string | null
          name: string
          not_found_runs: number
          slug: string
        }
        Insert: {
          active?: boolean
          ats: string
          created_at?: string
          discovered_via: string
          id?: string
          last_remote_job_at?: string | null
          name: string
          not_found_runs?: number
          slug: string
        }
        Update: {
          active?: boolean
          ats?: string
          created_at?: string
          discovered_via?: string
          id?: string
          last_remote_job_at?: string | null
          name?: string
          not_found_runs?: number
          slug?: string
        }
        Relationships: []
      }
      job_enrichment: {
        Row: {
          company_size: number | null
          countries: string[]
          created_at: string
          is_remote: boolean
          job_id: string
          regions: string[]
          role_family: string | null
          salary_usd_year_max: number | null
          salary_usd_year_min: number | null
          seniority: string | null
          summary: string | null
          technologies: string[]
        }
        Insert: {
          company_size?: number | null
          countries?: string[]
          created_at?: string
          is_remote: boolean
          job_id: string
          regions?: string[]
          role_family?: string | null
          salary_usd_year_max?: number | null
          salary_usd_year_min?: number | null
          seniority?: string | null
          summary?: string | null
          technologies?: string[]
        }
        Update: {
          company_size?: number | null
          countries?: string[]
          created_at?: string
          is_remote?: boolean
          job_id?: string
          regions?: string[]
          role_family?: string | null
          salary_usd_year_max?: number | null
          salary_usd_year_min?: number | null
          seniority?: string | null
          summary?: string | null
          technologies?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "job_enrichment_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: true
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      job_sources: {
        Row: {
          apply_url: string | null
          company_id: string | null
          created_at: string
          external_id: string
          id: string
          job_id: string
          last_seen_at: string
          remote_hint: boolean | null
          source: string
          stale_at: string | null
          url: string
        }
        Insert: {
          apply_url?: string | null
          company_id?: string | null
          created_at?: string
          external_id: string
          id?: string
          job_id: string
          last_seen_at?: string
          remote_hint?: boolean | null
          source: string
          stale_at?: string | null
          url: string
        }
        Update: {
          apply_url?: string | null
          company_id?: string | null
          created_at?: string
          external_id?: string
          id?: string
          job_id?: string
          last_seen_at?: string
          remote_hint?: boolean | null
          source?: string
          stale_at?: string | null
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_sources_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_sources_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      jobs: {
        Row: {
          collect_key: string | null
          company: string
          company_id: string | null
          created_at: string
          dedupe_key: string
          description: string
          first_seen_at: string
          id: string
          location_text: string | null
          posted_at: string | null
          salary_currency: string | null
          salary_max: number | null
          salary_min: number | null
          salary_period: string | null
          status: string
          title: string
        }
        Insert: {
          collect_key?: string | null
          company: string
          company_id?: string | null
          created_at?: string
          dedupe_key: string
          description: string
          first_seen_at?: string
          id?: string
          location_text?: string | null
          posted_at?: string | null
          salary_currency?: string | null
          salary_max?: number | null
          salary_min?: number | null
          salary_period?: string | null
          status?: string
          title: string
        }
        Update: {
          collect_key?: string | null
          company?: string
          company_id?: string | null
          created_at?: string
          dedupe_key?: string
          description?: string
          first_seen_at?: string
          id?: string
          location_text?: string | null
          posted_at?: string | null
          salary_currency?: string | null
          salary_max?: number | null
          salary_min?: number | null
          salary_period?: string | null
          status?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "jobs_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      matches: {
        Row: {
          catchup: boolean
          created_at: string
          emailed_at: string | null
          id: string
          is_match: boolean
          job_id: string
          reason: string
          score: number
          subscriber_id: string
          suppressed: boolean
        }
        Insert: {
          catchup?: boolean
          created_at?: string
          emailed_at?: string | null
          id?: string
          is_match: boolean
          job_id: string
          reason: string
          score: number
          subscriber_id: string
          suppressed?: boolean
        }
        Update: {
          catchup?: boolean
          created_at?: string
          emailed_at?: string | null
          id?: string
          is_match?: boolean
          job_id?: string
          reason?: string
          score?: number
          subscriber_id?: string
          suppressed?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "matches_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matches_subscriber_id_fkey"
            columns: ["subscriber_id"]
            isOneToOne: false
            referencedRelation: "subscribers"
            referencedColumns: ["id"]
          },
        ]
      }
      runs: {
        Row: {
          created_at: string
          errors: Json
          est_cost_usd: number
          finished_at: string | null
          id: string
          input_tokens: number
          output_tokens: number
          started_at: string
          stats: Json
          status: string
        }
        Insert: {
          created_at?: string
          errors?: Json
          est_cost_usd?: number
          finished_at?: string | null
          id?: string
          input_tokens?: number
          output_tokens?: number
          started_at?: string
          stats?: Json
          status?: string
        }
        Update: {
          created_at?: string
          errors?: Json
          est_cost_usd?: number
          finished_at?: string | null
          id?: string
          input_tokens?: number
          output_tokens?: number
          started_at?: string
          stats?: Json
          status?: string
        }
        Relationships: []
      }
      source_poll_state: {
        Row: {
          created_at: string
          last_attempt_at: string
          source: string
        }
        Insert: {
          created_at?: string
          last_attempt_at: string
          source: string
        }
        Update: {
          created_at?: string
          last_attempt_at?: string
          source?: string
        }
        Relationships: []
      }
      subscribers: {
        Row: {
          active: boolean
          constraints: Json | null
          created_at: string
          email: string
          id: string
          last_digest_on: string | null
          location: string
          name: string | null
          prompt: string
          prompt_hash: string | null
        }
        Insert: {
          active?: boolean
          constraints?: Json | null
          created_at?: string
          email: string
          id?: string
          last_digest_on?: string | null
          location: string
          name?: string | null
          prompt: string
          prompt_hash?: string | null
        }
        Update: {
          active?: boolean
          constraints?: Json | null
          created_at?: string
          email?: string
          id?: string
          last_digest_on?: string | null
          location?: string
          name?: string | null
          prompt?: string
          prompt_hash?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      claim_jobicy_poll: { Args: never; Returns: boolean }
      collect_source_batch: {
        Args: {
          p_company_id?: string
          p_items: Json
          p_source: string
          p_started_at: string
        }
        Returns: Json
      }
      complete_digest_delivery: {
        Args: {
          p_cycle_id?: string
          p_match_ids: string[]
          p_subscriber_id: string
          p_today: string
        }
        Returns: undefined
      }
      insert_scored_matches: {
        Args: {
          p_location: string
          p_prompt: string
          p_prompt_hash: string
          p_results: Json
          p_subscriber_id: string
        }
        Returns: {
          is_match: boolean
          job_id: string
          suppressed: boolean
        }[]
      }
      refresh_subscriber_prompt: {
        Args: {
          p_constraints: Json
          p_cutoff: string
          p_location: string
          p_prompt: string
          p_prompt_hash: string
          p_subscriber_id: string
        }
        Returns: string
      }
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
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
