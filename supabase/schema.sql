-- ==============================================================================
-- ChatMind - Supabase Database Schema
-- Compatible with PostgreSQL 15+ and Supabase Realtime
-- ==============================================================================

-- 1. Enable necessary extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- 2. Profiles Table (Linked with Supabase Auth or custom users)
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    pic TEXT DEFAULT 'https://icon-library.com/images/anonymous-avatar-icon/anonymous-avatar-icon-25.jpg',
    is_admin BOOLEAN DEFAULT FALSE,
    password_hash TEXT, -- Optional if using custom auth or synced with auth.users
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Index for searching users
CREATE INDEX IF NOT EXISTS idx_profiles_email ON public.profiles (email);
CREATE INDEX IF NOT EXISTS idx_profiles_name ON public.profiles (name);

-- 3. Chats Table (1-on-1 and Group Chats)
CREATE TABLE IF NOT EXISTS public.chats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_name TEXT DEFAULT 'sender',
    is_group_chat BOOLEAN DEFAULT FALSE NOT NULL,
    group_admin_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    latest_message_id UUID,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Index for chat ordering
CREATE INDEX IF NOT EXISTS idx_chats_updated_at ON public.chats (updated_at DESC);

-- 4. Chat Members (Many-to-Many between Chats and Profiles)
CREATE TABLE IF NOT EXISTS public.chat_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id UUID NOT NULL REFERENCES public.chats(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE(chat_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_members_user_id ON public.chat_members (user_id);
CREATE INDEX IF NOT EXISTS idx_chat_members_chat_id ON public.chat_members (chat_id);

-- 5. Messages Table
CREATE TABLE IF NOT EXISTS public.messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id UUID NOT NULL REFERENCES public.chats(id) ON DELETE CASCADE,
    sender_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON public.messages (chat_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_messages_sender_id ON public.messages (sender_id);

-- Add foreign key reference for latest_message_id in public.chats
ALTER TABLE public.chats 
    DROP CONSTRAINT IF EXISTS fk_chats_latest_message,
    ADD CONSTRAINT fk_chats_latest_message 
    FOREIGN KEY (latest_message_id) REFERENCES public.messages(id) ON DELETE SET NULL;

-- 6. Trigger: Update chat updated_at and latest_message_id on new message
CREATE OR REPLACE FUNCTION public.handle_new_message()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE public.chats
    SET latest_message_id = NEW.id,
        updated_at = NEW.created_at
    WHERE id = NEW.chat_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_message_created ON public.messages;
CREATE TRIGGER on_message_created
    AFTER INSERT ON public.messages
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_new_message();

-- 7. Trigger: Auto-create Profile when a user signs up via Supabase Auth
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.profiles (id, auth_user_id, name, email, pic)
    VALUES (
        NEW.id,
        NEW.id,
        COALESCE(NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1)),
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'pic', 'https://icon-library.com/images/anonymous-avatar-icon/anonymous-avatar-icon-25.jpg')
    )
    ON CONFLICT (email) DO UPDATE 
    SET auth_user_id = EXCLUDED.auth_user_id,
        name = EXCLUDED.name;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_new_auth_user();

-- 8. Row Level Security (RLS) Setup
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

-- Profiles Policies
DROP POLICY IF EXISTS "Public profiles are viewable by authenticated users" ON public.profiles;
CREATE POLICY "Public profiles are viewable by authenticated users"
    ON public.profiles FOR SELECT
    USING (true);

DROP POLICY IF EXISTS "Users can insert their own profile" ON public.profiles;
CREATE POLICY "Users can insert their own profile"
    ON public.profiles FOR INSERT
    WITH CHECK (true);

DROP POLICY IF EXISTS "Users can update their own profile" ON public.profiles;
CREATE POLICY "Users can update their own profile"
    ON public.profiles FOR UPDATE
    USING (auth.uid() = auth_user_id OR auth.uid() = id);

-- Chats Policies
DROP POLICY IF EXISTS "Users can view chats they are part of" ON public.chats;
CREATE POLICY "Users can view chats they are part of"
    ON public.chats FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.chat_members
            WHERE chat_members.chat_id = chats.id
            AND (chat_members.user_id = auth.uid() OR chat_members.user_id IN (SELECT id FROM public.profiles WHERE auth_user_id = auth.uid()))
        )
    );

DROP POLICY IF EXISTS "Users can create chats" ON public.chats;
CREATE POLICY "Users can create chats"
    ON public.chats FOR INSERT
    WITH CHECK (true);

DROP POLICY IF EXISTS "Group admins or members can update chat" ON public.chats;
CREATE POLICY "Group admins or members can update chat"
    ON public.chats FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM public.chat_members
            WHERE chat_members.chat_id = chats.id
            AND (chat_members.user_id = auth.uid() OR chat_members.user_id IN (SELECT id FROM public.profiles WHERE auth_user_id = auth.uid()))
        )
    );

-- Chat Members Policies
DROP POLICY IF EXISTS "Members can view participants of their chats" ON public.chat_members;
CREATE POLICY "Members can view participants of their chats"
    ON public.chat_members FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.chat_members AS cm
            WHERE cm.chat_id = chat_members.chat_id
            AND (cm.user_id = auth.uid() OR cm.user_id IN (SELECT id FROM public.profiles WHERE auth_user_id = auth.uid()))
        )
    );

DROP POLICY IF EXISTS "Users can add chat members" ON public.chat_members;
CREATE POLICY "Users can add chat members"
    ON public.chat_members FOR INSERT
    WITH CHECK (true);

DROP POLICY IF EXISTS "Users can leave or admin can remove members" ON public.chat_members;
CREATE POLICY "Users can leave or admin can remove members"
    ON public.chat_members FOR DELETE
    USING (
        user_id = auth.uid() 
        OR user_id IN (SELECT id FROM public.profiles WHERE auth_user_id = auth.uid())
        OR EXISTS (
            SELECT 1 FROM public.chats 
            WHERE chats.id = chat_members.chat_id 
            AND (chats.group_admin_id = auth.uid() OR chats.group_admin_id IN (SELECT id FROM public.profiles WHERE auth_user_id = auth.uid()))
        )
    );

-- Messages Policies
DROP POLICY IF EXISTS "Chat members can view messages" ON public.messages;
CREATE POLICY "Chat members can view messages"
    ON public.messages FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.chat_members
            WHERE chat_members.chat_id = messages.chat_id
            AND (chat_members.user_id = auth.uid() OR chat_members.user_id IN (SELECT id FROM public.profiles WHERE auth_user_id = auth.uid()))
        )
    );

DROP POLICY IF EXISTS "Chat members can send messages" ON public.messages;
CREATE POLICY "Chat members can send messages"
    ON public.messages FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.chat_members
            WHERE chat_members.chat_id = messages.chat_id
            AND (chat_members.user_id = auth.uid() OR chat_members.user_id IN (SELECT id FROM public.profiles WHERE auth_user_id = auth.uid()))
        )
    );

-- 9. Enable Realtime on messages, chats, and chat_members
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables 
        WHERE pubname = 'supabase_realtime' AND tablename = 'messages'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables 
        WHERE pubname = 'supabase_realtime' AND tablename = 'chats'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.chats;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables 
        WHERE pubname = 'supabase_realtime' AND tablename = 'chat_members'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_members;
    END IF;
END $$;

-- 10. Storage Bucket for Avatars & Media
INSERT INTO storage.buckets (id, name, public)
VALUES ('avatars', 'avatars', true)
ON CONFLICT (id) DO NOTHING;

-- Storage bucket policies
DROP POLICY IF EXISTS "Avatar images are publicly accessible" ON storage.objects;
CREATE POLICY "Avatar images are publicly accessible"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'avatars');

DROP POLICY IF EXISTS "Authenticated users can upload avatars" ON storage.objects;
CREATE POLICY "Authenticated users can upload avatars"
    ON storage.objects FOR INSERT
    WITH CHECK (bucket_id = 'avatars');
