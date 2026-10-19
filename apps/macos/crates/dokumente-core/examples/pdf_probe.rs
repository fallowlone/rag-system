use dokumente_core::extraction;

fn main() {
    let path = std::env::args().nth(1).expect("usage: pdf_probe <file>");
    match extraction::extract_text(std::path::Path::new(&path)) {
        Ok(text) => {
            println!("kind: {:?}", text.kind);
            println!("chars: {}", text.text.chars().count());
            println!("first 400 chars:\n{}", text.text.chars().take(400).collect::<String>());
        }
        Err(e) => println!("ERROR: {e}"),
    }
}
