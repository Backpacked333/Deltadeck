// Where pictures load from: the Supabase project URL, or '' while unknown
// (a plate then shows the initial). LiveApp provides it (Avatar.tsx).
import { createContext } from 'react'

export const AvatarBase = createContext('')
