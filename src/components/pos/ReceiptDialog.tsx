import { Printer } from 'lucide-react';
import type { Sale, Settings } from '../../../shared/types';
import Receipt from '../Receipt';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';

export default function ReceiptDialog({ sale, settings, onClose }: { sale: Sale | null; settings: Settings | null; onClose: () => void }) {
  return (
    <Dialog open={!!sale} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader className="no-print pr-6">
          <DialogTitle>Documento de prueba</DialogTitle>
          <DialogDescription>Vista imprimible de 80 mm. La impresión directa de la iMin requiere una prueba en el equipo.</DialogDescription>
        </DialogHeader>
        {sale && settings ? <Receipt sale={sale} settings={settings} /> : null}
        <div className="no-print flex flex-wrap justify-end gap-2">
          <Button variant="outline" className="h-11" onClick={onClose}>Cerrar</Button>
          <Button className="h-11" onClick={() => window.print()}><Printer className="size-4" /> Imprimir vista</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
