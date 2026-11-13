import { AlertCircle, LoaderCircle, PackageOpen } from 'lucide-react';
import type { ReactNode } from 'react';
export function Loading() { return <div className="state-box"><LoaderCircle className="animate-spin" size={24}/><p>Cargando información…</p></div>; }
export function ErrorNotice({message}: {message: string}) { return <div role="alert" className="error-notice"><AlertCircle size={18}/><span>{message}</span></div>; }
export function Empty({title, children}: {title: string; children?: ReactNode}) { return <div className="state-box"><PackageOpen size={32}/><strong>{title}</strong>{children ? <p>{children}</p> : null}</div>; }
export function PageHeader({title, description, children}: {title:string; description:string; children?:ReactNode}) { return <div className="page-heading"><div><h1>{title}</h1><p>{description}</p></div>{children}</div>; }
